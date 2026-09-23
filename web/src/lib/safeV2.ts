import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import type { WalletAdapter } from "@solana/wallet-adapter-base";
import {
  ComputeBudgetProgram, Connection, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import bs58 from "bs58";
import idlJson from "@/idl/yield_vault.json";
import { USDC_MINT } from "./constants";
import { deriveVaultPda, resolveTransferHookAccounts } from "./vault";

export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
/** Allocation routes (indices into Vault.allocation_bps); must match ROUTE_* in the program. */
export const ROUTES = [
  { index: 0, key: "kaminoUsdc", label: "Kamino USDC" },
  { index: 1, key: "onyc", label: "ONyc" },
] as const;
export const MAX_ROUTES = 8;
export const ZERO_ALLOCATION = Array(MAX_ROUTES).fill(0) as number[];
/** 8 discriminator + bump + owner + agent + allocation [u16; 8] + ts + Vec<Pubkey> (max 16). */
const VAULT_ACCOUNT_SIZE = 8 + 1 + 32 + 32 + 16 + 8 + 4 + 16 * 32;
const TOKEN_ACCOUNT_SIZE = 165;
/** Base fee plus priority headroom; a wallet below this cannot pay for any transaction. */
export const MIN_FEE_LAMPORTS = 20_000;

/** SOL the owner needs to create a Safe: rent for the Safe account and its USDC ATA, plus fees. */
export async function safeCreationCostLamports(connection: Connection) {
  const [vaultRent, ataRent] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(VAULT_ACCOUNT_SIZE),
    connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE),
  ]);
  return vaultRent + ataRent + MIN_FEE_LAMPORTS;
}

/** Turn raw simulation failures into something a user can act on. */
function explainSimulationError(err: unknown, logs: string[], chain: string) {
  const raw = JSON.stringify(err);
  const cluster = chain === "solana:devnet" ? "Solana Devnet" : "Solana";
  const faucet = chain === "solana:devnet" ? " Get free devnet SOL at https://faucet.solana.com." : "";
  if (raw.includes("AccountNotFound") || raw.includes("InsufficientFundsForFee")) {
    return `Your wallet has no SOL on ${cluster} to pay the network fee (about 0.00001 SOL).${faucet}`;
  }
  if (raw.includes("InsufficientFundsForRent") || logs.some((line) => /insufficient lamports|insufficient funds for rent/i.test(line))) {
    return `Not enough SOL on ${cluster} to pay the one-time account rent for this action. Top up your wallet and retry.${faucet}`;
  }
  const anchorMessage = logs.map((line) => /Error Message: (.*?)\.?$/.exec(line)?.[1]).find(Boolean);
  if (anchorMessage) return `The program rejected this action: ${anchorMessage}.`;
  if (logs.some((line) => /Error: insufficient funds/.test(line))) {
    return "The Safe or your wallet does not hold enough tokens for this amount.";
  }
  const detail = logs.filter((line) => /Error|failed/.test(line)).slice(-3).join("\n");
  return `Simulation failed: ${raw}${detail ? `\n${detail}` : ""}`;
}

export type SafeToken = {
  pubkey: PublicKey;
  mint: PublicKey;
  programId: PublicKey;
  amount: bigint;
  uiAmount: string;
  decimals: number;
  isUsdc: boolean;
};

export type SafeState = {
  vault: PublicKey;
  exists: boolean;
  agent: PublicKey | null;
  /** Target bps per route; null when the account predates the allocation layout (sum > 10_000). */
  allocationBps: number[] | null;
  lamports: number;
  rentMinimum: number;
  excessLamports: number;
  tokens: SafeToken[];
};

/** Instruction-building only: the wallet is never asked to sign through Anchor. */
function program(connection: Connection, owner: PublicKey) {
  const readOnlyWallet = {
    publicKey: owner,
    signTransaction: async <T,>(tx: T) => tx,
    signAllTransactions: async <T,>(txs: T[]) => txs,
  };
  return new Program(idlJson as Idl, new AnchorProvider(connection, readOnlyWallet as never, { commitment: "confirmed" }));
}

export async function readSafe(connection: Connection, owner: PublicKey): Promise<SafeState> {
  const [vault] = deriveVaultPda(owner);
  const info = await connection.getAccountInfo(vault, "confirmed");
  const tokens: SafeToken[] = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const res = await connection.getParsedTokenAccountsByOwner(vault, { programId }, "confirmed");
    for (const { pubkey, account } of res.value) {
      const parsed = (account.data as { parsed: { info: { mint: string; tokenAmount: { amount: string; uiAmountString: string; decimals: number } } } }).parsed.info;
      const mint = new PublicKey(parsed.mint);
      tokens.push({
        pubkey, mint, programId,
        amount: BigInt(parsed.tokenAmount.amount),
        uiAmount: parsed.tokenAmount.uiAmountString,
        decimals: parsed.tokenAmount.decimals,
        isUsdc: mint.equals(USDC_MINT),
      });
    }
  }
  if (!info) return { vault, exists: false, agent: null, allocationBps: null, lamports: 0, rentMinimum: 0, excessLamports: 0, tokens };
  const rentMinimum = await connection.getMinimumBalanceForRentExemption(info.data.length);
  const decoded = program(connection, owner).coder.accounts.decode("vault", info.data) as { agent: PublicKey; allocationBps: number[] };
  // A Safe created before the allocation layout decodes garbage here; set_allocation rewrites it.
  const allocationValid = decoded.allocationBps.reduce((sum, bps) => sum + bps, 0) <= 10_000;
  return {
    vault, exists: true, agent: decoded.agent, allocationBps: allocationValid ? decoded.allocationBps : null,
    lamports: info.lamports, rentMinimum, excessLamports: Math.max(0, info.lamports - rentMinimum), tokens,
  };
}

export async function ixInitialize(connection: Connection, owner: PublicKey) {
  const [vault] = deriveVaultPda(owner);
  // No agent and no CPI allowlist: every agent action will get its own constrained instruction.
  return program(connection, owner).methods
    .initialize(PublicKey.default, ZERO_ALLOCATION, [])
    .accountsPartial({
      owner, vault, usdcMint: USDC_MINT,
      vaultUsdcAta: getAssociatedTokenAddressSync(USDC_MINT, vault, true),
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export async function ixDepositUsdc(connection: Connection, owner: PublicKey, amount: bigint) {
  const [vault] = deriveVaultPda(owner);
  return program(connection, owner).methods
    .deposit(new BN(amount.toString()))
    .accountsPartial({
      owner, vault, usdcMint: USDC_MINT,
      ownerUsdcAta: getAssociatedTokenAddressSync(USDC_MINT, owner),
      vaultUsdcAta: getAssociatedTokenAddressSync(USDC_MINT, vault, true),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

/** USDC uses `withdraw`; any other mint uses `withdraw_spl` (creates the owner ATA if missing, resolves transfer hooks). */
export async function ixWithdraw(connection: Connection, owner: PublicKey, token: SafeToken, amount: bigint) {
  const [vault] = deriveVaultPda(owner);
  const methods = program(connection, owner).methods;
  if (token.isUsdc && token.programId.equals(TOKEN_PROGRAM_ID)) {
    return methods.withdraw(new BN(amount.toString()))
      .accountsPartial({
        owner, vault, usdcMint: USDC_MINT,
        ownerUsdcAta: getAssociatedTokenAddressSync(USDC_MINT, owner),
        vaultUsdcAta: token.pubkey, tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }
  const ownerAta = getAssociatedTokenAddressSync(token.mint, owner, false, token.programId);
  const hookAccounts = token.programId.equals(TOKEN_2022_PROGRAM_ID)
    ? await resolveTransferHookAccounts({
      connection, source: token.pubkey, mint: token.mint, destination: ownerAta, owner: vault,
      amount: amount.toString(), tokenProgram: token.programId,
    })
    : [];
  return methods.withdrawSpl(new BN(amount.toString()))
    .accountsPartial({
      owner, vault, mint: token.mint, ownerTokenAta: ownerAta, vaultTokenAta: token.pubkey,
      tokenProgram: token.programId, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(hookAccounts)
    .instruction();
}

export async function ixSetAllocation(connection: Connection, owner: PublicKey, allocationBps: number[]) {
  const [vault] = deriveVaultPda(owner);
  return program(connection, owner).methods.setAllocation(allocationBps)
    .accountsPartial({ owner, vault }).instruction();
}

export async function ixCloseEmptyTokenAccount(connection: Connection, owner: PublicKey, token: SafeToken) {
  const [vault] = deriveVaultPda(owner);
  return program(connection, owner).methods.closeEmptyTokenAccount()
    .accountsPartial({ owner, vault, tokenAccount: token.pubkey, tokenProgram: token.programId })
    .instruction();
}

export async function ixWithdrawExcessLamports(connection: Connection, owner: PublicKey) {
  const [vault] = deriveVaultPda(owner);
  return program(connection, owner).methods.withdrawExcessLamports()
    .accountsPartial({ owner, vault }).instruction();
}

export async function ixCloseSafe(connection: Connection, owner: PublicKey) {
  const [vault] = deriveVaultPda(owner);
  return program(connection, owner).methods.closeSafe()
    .accountsPartial({ owner, vault }).instruction();
}

type StandardSignAndSend = {
  signAndSendTransaction: (...inputs: { account: unknown; transaction: Uint8Array; chain: string }[]) =>
    Promise<{ signature: Uint8Array }[]>;
};

/**
 * Owner is the only signer and fee payer. Sends through Wallet Standard `signAndSendTransaction`
 * with an explicit chain derived from the RPC genesis: MetaMask only works this way, and the
 * adapter's own sendTransaction guesses the chain from the RPC URL.
 */
export async function sendOwnerTransaction(args: {
  connection: Connection;
  adapter: WalletAdapter;
  owner: PublicKey;
  instructions: TransactionInstruction[];
  onStatus?: (line: string) => void;
}): Promise<string> {
  const { connection, adapter, owner } = args;
  const say = args.onStatus ?? (() => {});
  const genesis = await connection.getGenesisHash();
  const chain = genesis === MAINNET_GENESIS ? "solana:mainnet" : genesis === DEVNET_GENESIS ? "solana:devnet" : null;
  if (!chain) throw new Error(`unsupported cluster (genesis ${genesis})`);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: owner, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...args.instructions],
  }).compileToV0Message());
  const sim = await connection.simulateTransaction(tx, { sigVerify: false });
  if (sim.value.err) throw new Error(explainSimulationError(sim.value.err, sim.value.logs ?? [], chain));
  say(`Simulation ok (${sim.value.unitsConsumed ?? "?"} CU, ${chain}). Waiting for wallet...`);

  let signature: string;
  const standard = "standard" in adapter && adapter.standard
    ? (adapter as unknown as { wallet: { accounts: { address: string }[]; features: Record<string, unknown> } }).wallet
    : null;
  const account = standard?.accounts.find((item) => item.address === owner.toBase58());
  const feature = standard?.features["solana:signAndSendTransaction"] as StandardSignAndSend | undefined;
  if (account && feature) {
    const [output] = await feature.signAndSendTransaction({ account, transaction: tx.serialize(), chain });
    signature = bs58.encode(output.signature);
  } else {
    signature = await adapter.sendTransaction(tx, connection);
  }
  say(`Sent ${signature}. Confirming...`);
  for (;;) {
    const status = (await connection.getSignatureStatuses([signature])).value[0];
    if (status?.err) throw new Error(`transaction failed on chain: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature;
    if (await connection.getBlockHeight("confirmed") > lastValidBlockHeight) throw new Error("blockhash expired before confirmation");
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

export function explorerTx(signature: string, genesis: string | null) {
  return `https://solscan.io/tx/${signature}${genesis === DEVNET_GENESIS ? "?cluster=devnet" : ""}`;
}
