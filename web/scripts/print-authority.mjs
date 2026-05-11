// Prints the agent authority pubkey + mainnet SOL balance, derived from
// `AUTHORITY_SECRET_KEY` in web/.env.local (or web/.env). Accepts either
// a JSON array (`[1,2,...]`) or a base58 secret-key string — same format
// the runtime accepts in `loadAuthorityKeypairFromEnv`.
//
// Usage:
//   cd web
//   node scripts/print-authority.mjs
//
// Optional: pass an explicit RPC URL as the first arg to override
// `RPC_URL` / `NEXT_PUBLIC_RPC_URL` from env.
//   node scripts/print-authority.mjs https://api.mainnet-beta.solana.com

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import "dotenv/config";

function loadAuthority() {
  const raw = process.env.AUTHORITY_SECRET_KEY?.trim();
  if (!raw) {
    throw new Error(
      "AUTHORITY_SECRET_KEY is not set. Make sure web/.env.local exists and " +
        "contains AUTHORITY_SECRET_KEY=... (either JSON array or base58).",
    );
  }
  if (raw.startsWith("[")) {
    const arr = JSON.parse(raw);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  return Keypair.fromSecretKey(bs58.decode(raw));
}

async function main() {
  const rpcOverride = process.argv[2];
  const rpc =
    rpcOverride ??
    process.env.RPC_URL ??
    process.env.NEXT_PUBLIC_RPC_URL ??
    "https://api.mainnet-beta.solana.com";

  const authority = loadAuthority();
  const pubkey = authority.publicKey;

  const conn = new Connection(rpc, "confirmed");
  const lamports = await conn.getBalance(pubkey, "confirmed");
  const sol = lamports / LAMPORTS_PER_SOL;

  // Sanity check the pubkey is well-formed (also catches a corrupted base58
  // input that somehow decoded to the wrong byte length).
  new PublicKey(pubkey.toBase58());

  const RECOMMENDED_LAMPORTS = 50_000_000; // 0.05 SOL
  const MIN_LAMPORTS = 5_000_000;          // 0.005 SOL
  const status =
    lamports >= RECOMMENDED_LAMPORTS
      ? "OK"
      : lamports >= MIN_LAMPORTS
        ? "LOW — top up soon"
        : "BLOCKED — top up before running Jupiter Lend ops";

  console.log("=== Yield AI agent authority ===");
  console.log("RPC      :", rpc);
  console.log("Pubkey   :", pubkey.toBase58());
  console.log("Balance  :", `${sol.toFixed(6)} SOL  (${lamports} lamports)`);
  console.log("Status   :", status);
  console.log();
  console.log("If status is LOW or BLOCKED, send 0.01–0.05 SOL to:");
  console.log("  ", pubkey.toBase58());
  console.log(
    "This wallet pays tx fees, priority fees, and rent for Jupiter Lend setup " +
      "accounts (e.g. InitTickIdLiquidation). It only ever holds SOL — no user " +
      "funds — so it's safe to top up from any source.",
  );
}

main().catch((err) => {
  console.error("print-authority failed:", err.message ?? err);
  process.exit(1);
});
