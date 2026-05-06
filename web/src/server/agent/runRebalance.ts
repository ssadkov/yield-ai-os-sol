import bs58 from "bs58";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { convertAll, rebalance, individualSwap, type RebalanceResult } from "./rebalance/engine";
import { buildKaminoKvaultDepositTx, buildKaminoKvaultWithdrawTx } from "./protocols/kaminoKvault";
import { readVaultAccount } from "./rebalance/portfolio";
import { signAndSendTx } from "./swap/send";
import { deriveVaultPda } from "./swap/anchorIx";

export type RebalanceAction = "rebalance" | "convert_all";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length ? v : undefined;
}

function loadAuthorityKeypairFromEnv(): Keypair {
  const raw = requiredEnv("AUTHORITY_SECRET_KEY").trim();

  // Accept either JSON array "[1,2,...]" or base58 secret key.
  if (raw.startsWith("[")) {
    const arr = JSON.parse(raw) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }

  const bytes = bs58.decode(raw);
  return Keypair.fromSecretKey(bytes);
}

export async function runRebalanceJob(args: {
  ownerPubkey: string;
  action?: RebalanceAction;
}): Promise<RebalanceResult> {
  const apiKey = requiredEnv("JUPITER_API_KEY");
  const rpcUrl = optionalEnv("RPC_URL") ?? optionalEnv("NEXT_PUBLIC_RPC_URL") ?? "";
  if (!rpcUrl) throw new Error("Missing RPC_URL");

  const vaultProgramIdStr =
    optionalEnv("VAULT_PROGRAM_ID") ?? optionalEnv("NEXT_PUBLIC_PROGRAM_ID") ?? "";
  if (!vaultProgramIdStr) throw new Error("Missing VAULT_PROGRAM_ID");

  const slippageBps = Number(optionalEnv("SLIPPAGE_BPS") ?? "100");
  if (!Number.isFinite(slippageBps) || slippageBps <= 0) {
    throw new Error("Invalid SLIPPAGE_BPS");
  }

  const authority = loadAuthorityKeypairFromEnv();
  const vaultProgramId = new PublicKey(vaultProgramIdStr);
  const vaultOwner = new PublicKey(args.ownerPubkey);
  const connection = new Connection(rpcUrl, "confirmed");

  const fn = args.action === "convert_all" ? convertAll : rebalance;
  return fn({
    connection,
    authority,
    vaultProgramId,
    vaultOwner,
    apiKey,
    rpcUrl,
    slippageBps,
  });
}

export async function runIndividualSwapJob(args: {
  ownerPubkey: string;
  inputMint: string;
  outputMint: string;
  amount: string;
  amountUsd: number;
  slippageBps?: number;
}): Promise<RebalanceResult> {
  const apiKey = requiredEnv("JUPITER_API_KEY");
  const rpcUrl = optionalEnv("RPC_URL") ?? optionalEnv("NEXT_PUBLIC_RPC_URL") ?? "";
  if (!rpcUrl) throw new Error("Missing RPC_URL");

  const vaultProgramIdStr =
    optionalEnv("VAULT_PROGRAM_ID") ?? optionalEnv("NEXT_PUBLIC_PROGRAM_ID") ?? "";
  if (!vaultProgramIdStr) throw new Error("Missing VAULT_PROGRAM_ID");

  const authority = loadAuthorityKeypairFromEnv();
  const vaultProgramId = new PublicKey(vaultProgramIdStr);
  const vaultOwner = new PublicKey(args.ownerPubkey);
  const connection = new Connection(rpcUrl, "confirmed");

  const slippageBps = args.slippageBps ?? Number(optionalEnv("SLIPPAGE_BPS") ?? "100");

  return individualSwap({
    connection,
    authority,
    vaultProgramId,
    vaultOwner,
    apiKey,
    rpcUrl,
    inputMint: args.inputMint,
    outputMint: args.outputMint,
    amount: args.amount,
    amountUsd: args.amountUsd,
    slippageBps,
  });
}

export async function runKaminoKvaultDepositJob(args: {
  ownerPubkey: string;
  kvault: string;
  amount: string;
}): Promise<RebalanceResult> {
  return runKaminoKvaultActionJob({ ...args, action: "deposit" });
}

export async function runKaminoKvaultWithdrawJob(args: {
  ownerPubkey: string;
  kvault: string;
  amount: string;
}): Promise<RebalanceResult> {
  return runKaminoKvaultActionJob({ ...args, action: "withdraw" });
}

async function runKaminoKvaultActionJob(args: {
  ownerPubkey: string;
  kvault: string;
  amount: string;
  action: "deposit" | "withdraw";
}): Promise<RebalanceResult> {
  const rpcUrl = optionalEnv("RPC_URL") ?? optionalEnv("NEXT_PUBLIC_RPC_URL") ?? "";
  if (!rpcUrl) throw new Error("Missing RPC_URL");

  const vaultProgramIdStr =
    optionalEnv("VAULT_PROGRAM_ID") ?? optionalEnv("NEXT_PUBLIC_PROGRAM_ID") ?? "";
  if (!vaultProgramIdStr) throw new Error("Missing VAULT_PROGRAM_ID");

  const authority = loadAuthorityKeypairFromEnv();
  const vaultProgramId = new PublicKey(vaultProgramIdStr);
  const vaultOwner = new PublicKey(args.ownerPubkey);
  const vaultPda = deriveVaultPda(vaultProgramId, vaultOwner);
  const connection = new Connection(rpcUrl, "confirmed");

  const buildTx = args.action === "deposit" ? buildKaminoKvaultDepositTx : buildKaminoKvaultWithdrawTx;
  const [vault, built] = await Promise.all([
    readVaultAccount(connection, vaultPda),
    buildTx({
      connection,
      vaultProgramId,
      authority: authority.publicKey,
      vault: vaultPda,
      kvault: new PublicKey(args.kvault),
      amount: args.amount,
    }),
  ]);

  const whitelistedSet = new Set(vault.allowedPrograms.map((p) => p.toBase58()));
  const missing = built.requiredPrograms.filter((p) => !whitelistedSet.has(p));
  if (missing.length > 0) {
    return { status: "needs_whitelist", missingPrograms: missing, swaps: [] };
  }

  const signatures: string[] = [];
  for (let i = 0; i < built.txs.length; i++) {
    const tx = built.txs[i];
    const result = await signAndSendTx({
      connection,
      authority,
      ixs: tx.ixs,
      alts: built.alts,
    });

    if (result.err) {
      return {
        status: "error",
        signatures,
        swaps: [],
        error: `Kamino kVault ${args.action} (${tx.label}, step ${i + 1}/${built.txs.length}) failed: ${JSON.stringify(result.err)}. Build summary: ${JSON.stringify(built.summary)}`,
      };
    }
    if (result.signature) signatures.push(result.signature);
  }

  return { status: "success", signatures, swaps: [] };
}

