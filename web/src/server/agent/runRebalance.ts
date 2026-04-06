import bs58 from "bs58";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { convertAll, rebalance, individualSwap, type RebalanceResult } from "./rebalance/engine";

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


