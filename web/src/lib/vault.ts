import { Program, AnchorProvider, type Idl, BN } from "@coral-xyz/anchor";
import {
  type AccountMeta,
  PublicKey,
  Connection,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createTransferCheckedWithTransferHookInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { PROGRAM_ID, USDC_MINT, AGENT_PUBKEY } from "./constants";
import idlJson from "@/idl/yield_vault.json";

export type StrategyName = "Conservative" | "Balanced" | "Aggressive";


export interface VaultAccount {
  bump: number;
  owner: PublicKey;
  agent: PublicKey;
  /** v1 field; v2 stores allocationBps instead. Legacy flows read it as Conservative. */
  strategy?: { conservative?: object; balanced?: object; growth?: object };
  allocationBps?: number[];
  lastRebalanceTs: BN;
  allowedPrograms: PublicKey[];
}

export function deriveVaultPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer()],
    PROGRAM_ID
  );
}

function getProgram(provider: AnchorProvider): Program {
  return new Program(idlJson as Idl, provider);
}

export async function fetchVaultAccount(
  connection: Connection,
  owner: PublicKey
): Promise<VaultAccount | null> {
  const [vaultPda] = deriveVaultPda(owner);
  const info = await connection.getAccountInfo(vaultPda);
  if (!info) return null;

  const provider = new AnchorProvider(
    connection,
    { publicKey: owner, signTransaction: async <T,>(t: T) => t, signAllTransactions: async <T,>(t: T[]) => t } as never,
    { preflightCommitment: "confirmed" }
  );
  const program = getProgram(provider);
  try {
    const vault = await (program.account as Record<string, { fetch(addr: PublicKey): Promise<VaultAccount> }>)["vault"].fetch(vaultPda);
    return vault;
  } catch {
    return null;
  }
}

export function parseStrategy(s: VaultAccount["strategy"]): StrategyName {
  if (!s || "conservative" in s) return "Conservative";
  if ("balanced" in s) return "Balanced";
  return "Aggressive";
}

/**
 * Known program IDs the vault may CPI into.
 * Max 16 entries on-chain in v2 (was 64); keep this list merged with existing vault entries
 * when updating, because set_allowed_programs rewrites the whole list.
 */
/**
 * The Safe's generic-CPI allowlist is not managed from this app. Additions need a
 * propose -> 48 h -> activate flow on-chain (docs/safe-cpi-policy-and-orca.md), and the agent
 * never uses generic CPI. Routes that need a program outside the allowlist are unavailable.
 */
export const ALLOWLIST_DISABLED_MESSAGE =
  "This action needs a program outside the Safe's allowlist. The app no longer asks you to add programs: " +
  "agent actions use dedicated Safe instructions, and allowlist additions are a timelocked owner action.";

export async function initializeVault(
  provider: AnchorProvider,
  strategy: StrategyName
) {
  const program = getProgram(provider);
  const owner = provider.wallet.publicKey;
  const [vault] = deriveVaultPda(owner);
  const [executorLimits] = PublicKey.findProgramAddressSync(
    [Buffer.from("executor_limits"), vault.toBuffer()], program.programId,
  );
  const [executorRegistry] = PublicKey.findProgramAddressSync([Buffer.from("executor_registry")], program.programId);
  let agent = AGENT_PUBKEY;
  if (await provider.connection.getGenesisHash() === "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") {
    const registry = await (program.account as unknown as Record<string, { fetch(key: PublicKey): Promise<{
      defaultExecutor: PublicKey; approved: PublicKey[]
    }> }>)["executorRegistry"].fetch(executorRegistry);
    agent = registry.defaultExecutor;
    if (agent.equals(PublicKey.default) || !registry.approved.some((key) => key.equals(agent))) {
      throw new Error("The admin has not approved a default executor for this Safe");
    }
  }

  const sig = await program.methods
    // v2: strategy presets are replaced by owner allocation targets (set later via set_allocation).
    // v2 allowlist holds at most 16 programs and generic CPI is owner-only; start empty.
    .initializeWithLimits(agent, Array(8).fill(0), [])
    .accounts({
      owner,
      vault,
      executorLimits,
      executorRegistry,
      usdcMint: USDC_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  return sig;
}

export async function depositUsdc(
  provider: AnchorProvider,
  amount: number
) {
  const program = getProgram(provider);
  const owner = provider.wallet.publicKey;
  const [vaultPda] = deriveVaultPda(owner);

  const ownerAta = await getAssociatedTokenAddress(USDC_MINT, owner);
  const vaultAta = await getAssociatedTokenAddress(USDC_MINT, vaultPda, true);

  const sig = await program.methods
    .deposit(new BN(amount))
    .accounts({
      owner,
      usdcMint: USDC_MINT,
      ownerUsdcAta: ownerAta,
      vaultUsdcAta: vaultAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  return sig;
}

export async function withdrawUsdc(
  provider: AnchorProvider,
  amount: number
) {
  const program = getProgram(provider);
  const owner = provider.wallet.publicKey;
  const [vaultPda] = deriveVaultPda(owner);

  const ownerAta = await getAssociatedTokenAddress(USDC_MINT, owner);
  const vaultAta = await getAssociatedTokenAddress(USDC_MINT, vaultPda, true);

  const sig = await program.methods
    .withdraw(new BN(amount))
    .accounts({
      owner,
      usdcMint: USDC_MINT,
      ownerUsdcAta: ownerAta,
      vaultUsdcAta: vaultAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  return sig;
}

export async function depositSpl(
  provider: AnchorProvider,
  mint: PublicKey,
  amount: number | string | BN,
  tokenProgram?: PublicKey,
  remainingAccounts?: AccountMeta[],
) {
  const program = getProgram(provider);
  const owner = provider.wallet.publicKey;
  const [vaultPda] = deriveVaultPda(owner);
  const resolvedTokenProgram =
    tokenProgram ?? (await resolveMintTokenProgram(provider.connection, mint));

  const ownerAta = await getAssociatedTokenAddress(mint, owner, false, resolvedTokenProgram);
  const vaultAta = await getAssociatedTokenAddress(mint, vaultPda, true, resolvedTokenProgram);
  const extraAccounts =
    remainingAccounts ??
    (await resolveTransferHookAccounts({
      connection: provider.connection,
      source: ownerAta,
      mint,
      destination: vaultAta,
      owner,
      amount,
      tokenProgram: resolvedTokenProgram,
    }));

  const sig = await program.methods
    .depositSpl(new BN(amount))
    .accounts({
      owner,
      mint,
      ownerTokenAta: ownerAta,
      vaultTokenAta: vaultAta,
      tokenProgram: resolvedTokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(extraAccounts)
    .rpc();

  return sig;
}

export async function withdrawSpl(
  provider: AnchorProvider,
  mint: PublicKey,
  amount: number | string | BN,
  tokenProgram?: PublicKey,
  remainingAccounts?: AccountMeta[],
) {
  const program = getProgram(provider);
  const owner = provider.wallet.publicKey;
  const [vaultPda] = deriveVaultPda(owner);
  const resolvedTokenProgram =
    tokenProgram ?? (await resolveMintTokenProgram(provider.connection, mint));

  const ownerAta = await getAssociatedTokenAddress(mint, owner, false, resolvedTokenProgram);
  const vaultAta = await getAssociatedTokenAddress(mint, vaultPda, true, resolvedTokenProgram);
  const extraAccounts =
    remainingAccounts ??
    (await resolveTransferHookAccounts({
      connection: provider.connection,
      source: vaultAta,
      mint,
      destination: ownerAta,
      owner: vaultPda,
      amount,
      tokenProgram: resolvedTokenProgram,
    }));

  const sig = await program.methods
    .withdrawSpl(new BN(amount))
    .accounts({
      owner,
      mint,
      ownerTokenAta: ownerAta,
      vaultTokenAta: vaultAta,
      tokenProgram: resolvedTokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(extraAccounts)
    .rpc();

  return sig;
}

export function tokenProgramForAsset(isToken2022?: boolean): PublicKey {
  return isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

export async function resolveMintTokenProgram(
  connection: Connection,
  mint: PublicKey,
): Promise<PublicKey> {
  const account = await connection.getAccountInfo(mint);
  if (!account) throw new Error(`Mint account not found: ${mint.toBase58()}`);
  if (account.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  if (account.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  throw new Error(`Unsupported token program for mint ${mint.toBase58()}: ${account.owner.toBase58()}`);
}

function amountToBigInt(amount: number | string | BN): bigint {
  if (BN.isBN(amount)) return BigInt(amount.toString());
  return BigInt(amount);
}

export async function resolveTransferHookAccounts(args: {
  connection: Connection;
  source: PublicKey;
  mint: PublicKey;
  destination: PublicKey;
  owner: PublicKey;
  amount: number | string | BN;
  tokenProgram: PublicKey;
}): Promise<AccountMeta[]> {
  const ix = await createTransferCheckedWithTransferHookInstruction(
    args.connection,
    args.source,
    args.mint,
    args.destination,
    args.owner,
    amountToBigInt(args.amount),
    0,
    [],
    "confirmed",
    args.tokenProgram,
  );
  const baseKeys = new Set(
    [args.source, args.mint, args.destination, args.owner].map((p) => p.toBase58()),
  );
  return ix.keys.filter((meta) => !baseKeys.has(meta.pubkey.toBase58()));
}

export async function getVaultUsdcBalance(
  connection: Connection,
  owner: PublicKey
): Promise<number> {
  const [vaultPda] = deriveVaultPda(owner);
  const vaultAta = await getAssociatedTokenAddress(USDC_MINT, vaultPda, true);
  try {
    const balance = await connection.getTokenAccountBalance(vaultAta);
    return Number(balance.value.amount);
  } catch {
    return 0;
  }
}
