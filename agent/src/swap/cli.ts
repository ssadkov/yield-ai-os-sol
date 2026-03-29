import "dotenv/config";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey, Connection } from "@solana/web3.js";
import { buildVaultSwapTx } from "./buildVaultSwapTx.ts";
import { deriveVaultPda } from "./anchorIx.ts";

async function assertYieldVaultReadyOnCluster(args: {
  connection: Connection;
  vaultProgramId: PublicKey;
  vaultPda: PublicKey;
}): Promise<void> {
  const { connection, vaultProgramId, vaultPda } = args;

  const programInfo = await connection.getAccountInfo(vaultProgramId, "confirmed");
  if (!programInfo) {
    throw new Error(
      `Program account not found at ${vaultProgramId.toBase58()} on this RPC cluster. ` +
        `Deploy yield_vault to mainnet-beta at this program id before simulating CPI swaps.`
    );
  }
  if (!programInfo.executable) {
    throw new Error(
      `Account at ${vaultProgramId.toBase58()} exists but is not an executable program.`
    );
  }

  const vaultInfo = await connection.getAccountInfo(vaultPda, "confirmed");
  if (!vaultInfo) {
    throw new Error(
      `Vault PDA ${vaultPda.toBase58()} has no account data on this cluster. ` +
        `Call initialize on mainnet (same owner pubkey as VAULT_OWNER_PUBKEY) and set allowed_programs ` +
        `to the program ids printed by this CLI.`
    );
  }
}

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid ${name}`);
  return n;
}

export async function runSwapCli(): Promise<void> {
  const apiKey = env("JUPITER_API_KEY");
  const rpcUrl = env("RPC_URL");
  const vaultProgramIdStr = env("VAULT_PROGRAM_ID");

  const authorityKeypairPath = env("AUTHORITY_KEYPAIR");
  const vaultOwnerPubkeyStr = env("VAULT_OWNER_PUBKEY");

  const inputMint = env("INPUT_MINT");
  const outputMint = env("OUTPUT_MINT");
  const amount = env("AMOUNT");
  const slippageBps = envInt("SLIPPAGE_BPS", 100);

  const mode = (process.env.MODE ?? "simulate").toLowerCase();

  const authority = loadKeypair(authorityKeypairPath);
  const vaultProgramId = new PublicKey(vaultProgramIdStr);
  const vaultOwner = new PublicKey(vaultOwnerPubkeyStr);
  const vaultPda = deriveVaultPda(vaultProgramId, vaultOwner);

  const connection = new Connection(rpcUrl, "confirmed");
  await assertYieldVaultReadyOnCluster({ connection, vaultProgramId, vaultPda });

  const built = await buildVaultSwapTx({
    apiKey,
    rpcUrl,
    vaultProgramId: vaultProgramId.toBase58(),
    authorityPubkey: authority.publicKey.toBase58(),
    vaultPubkey: vaultPda.toBase58(),
    inputMint,
    outputMint,
    amount,
    slippageBps,
  });

  console.log("Vault PDA:", vaultPda.toBase58());
  console.log("Whitelist program ids (unique, for initialize):");
  for (const pid of built.whitelistedProgramIds) console.log("-", pid);

  console.log("Simulation result:");
  console.log("  unitsConsumed:", built.simulateUnsigned?.unitsConsumed ?? null);
  console.log("  err:", built.simulateUnsigned?.err ?? null);
  const logs = built.simulateUnsigned?.logs ?? null;
  if (logs?.length) {
    console.log("  logs (first 60 lines):");
    for (const line of logs.slice(0, 60)) console.log("   ", line);
    if (logs.length > 60) console.log(`   ... (${logs.length - 60} more lines)`);
  }

  if (mode === "simulate") return;

  if (mode !== "send") throw new Error(`Unknown MODE: ${mode}`);

  built.tx.sign([authority]);
  const sig = await connection.sendRawTransaction(built.tx.serialize(), {
    skipPreflight: true,
    maxRetries: 0,
  });
  console.log("Sent:", sig);

  const confirmation = await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: built.blockhash.recentBlockhash,
      lastValidBlockHeight: built.blockhash.lastValidBlockHeight,
    },
    "confirmed"
  );
  console.log("Confirmed:", confirmation.value.err ?? null);
}

