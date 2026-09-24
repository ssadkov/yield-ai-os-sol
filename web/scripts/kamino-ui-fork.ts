// End-to-end check of the /v2/safe Kamino builders against a local mainnet fork.
// Needs a solana-test-validator cloning Kamino (see client/src/v2KaminoFork.ts "prepare") and
// /tmp/kfork keys; run from web/: tsx --tsconfig tsconfig.json scripts/kamino-ui-fork.ts
import { readFileSync } from "node:fs";
import { AnchorProvider, Program, type Idl, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, type TransactionInstruction } from "@solana/web3.js";
import idlJson from "../src/idl/yield_vault.json";
import {
  ixInitialize, ixSetAllocation, ixDepositUsdc, ixKaminoDeposit, ixKaminoWithdraw, readSafe,
  KAMINO_SHARES_MINT, ROUTE_KAMINO_USDC, type KaminoAccounts,
} from "../src/lib/safeV2";

const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const key = (name: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`/tmp/kfork/${name}.json`, "utf8"))));
const owner = key("owner"), treasury = Keypair.generate();
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/tmp/yield-v2-admin.json", "utf8"))));

async function send(label: string, signer: Keypair, ixs: TransactionInstruction[]) {
  const { blockhash } = await conn.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...ixs] }).compileToV0Message());
  tx.sign([signer]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false });
  await conn.confirmTransaction(sig, "confirmed");
  console.log(`  ok ${label} (${tx.serialize().length} bytes)`);
}

function toAccounts(kind: "deposit" | "withdraw", safe: PublicKey): KaminoAccounts {
  const api = JSON.parse(readFileSync("/tmp/kfork/kamino.json", "utf8"))[kind] as { programAddress: string; data: string; accounts: { address: string; role: string }[] }[];
  const ix = api.find((i) => i.programAddress.startsWith("Kvau"))!;
  if (ix.accounts[0].address !== safe.toBase58()) throw new Error("API accounts are for a different Safe");
  return { safe: safe.toBase58(), discriminator: Buffer.from(ix.data, "base64").subarray(0, 8).toString("hex"),
    accounts: ix.accounts.map((a) => ({ address: a.address, writable: a.role.includes("WRITABLE") })), lookupTables: [] };
}

(async () => {
  for (const kp of [owner, admin]) await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 2e9), "confirmed");
  // Protocol config (admin = upgrade authority of the forked program load).
  const prog = new Program(idlJson as Idl, new AnchorProvider(conn, new Wallet(admin), { commitment: "confirmed" }));
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], prog.programId);
  const [programData] = PublicKey.findProgramAddressSync([prog.programId.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"));
  await (prog.methods as any).initConfig(treasury.publicKey, 500).accounts({ admin: admin.publicKey, config, programData, systemProgram: SystemProgram.programId }).rpc();

  await send("create Safe", owner, [await ixInitialize(conn, owner.publicKey)]);
  await send("allocation 60% Kamino", owner, [await ixSetAllocation(conn, owner.publicKey, [6000, 0, 0, 0, 0, 0, 0, 0])]);
  await send("deposit 100 USDC", owner, [await ixDepositUsdc(conn, owner.publicKey, BigInt(100_000_000))]);
  let safe = await readSafe(conn, owner.publicKey);
  const idle = safe.tokens.find((t) => t.isUsdc)!.amount;
  const put = idle * BigInt(6000) / BigInt(10_000);
  await send(`Kamino deposit ${put}`, owner, await ixKaminoDeposit(conn, owner.publicKey, put, toAccounts("deposit", safe.vault)));
  safe = await readSafe(conn, owner.publicKey);
  const shares = safe.tokens.find((t) => t.mint.equals(KAMINO_SHARES_MINT))!.amount;
  console.log(`  Safe: shares ${shares}, principal ${safe.routePrincipal[ROUTE_KAMINO_USDC]}, idle ${safe.tokens.find((t) => t.isUsdc)!.amount}`);
  await send("Kamino withdraw all", owner, await ixKaminoWithdraw(conn, owner.publicKey, shares, toAccounts("withdraw", safe.vault)));
  safe = await readSafe(conn, owner.publicKey);
  const sharesAfter = safe.tokens.find((t) => t.mint.equals(KAMINO_SHARES_MINT))?.amount ?? BigInt(0);
  console.log(`  Safe after exit: shares ${sharesAfter}, principal ${safe.routePrincipal[ROUTE_KAMINO_USDC]}, USDC ${safe.tokens.find((t) => t.isUsdc)!.amount}`);
  if (sharesAfter !== BigInt(0) || safe.routePrincipal[ROUTE_KAMINO_USDC] !== BigInt(0)) throw new Error("exit incomplete");
  console.log("PASS: /v2/safe Kamino builders on mainnet fork");
})().catch((e) => { console.error(e); process.exit(1); });
