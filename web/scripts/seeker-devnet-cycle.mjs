/** Explicitly authorized native Devnet pilot. Signer remains in protected WSL storage. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync, fsyncSync, renameSync, mkdtempSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import ts from "typescript";
import { BorshInstructionCoder, BorshAccountsCoder } from "@coral-xyz/anchor";
import { Keypair, PublicKey, Connection, TransactionInstruction, TransactionMessage, VersionedTransaction, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import idl from "../src/idl/yield_vault.json" with { type: "json" };
assert.equal(process.platform, "linux");
assert.equal(process.env.V2_SEEKER_ACK, "DEVNET_REGISTRY_AND_ONE_USDC_ROUNDTRIP");
assert(process.argv.includes("--send-reviewed"));
const keyPath = "/home/sergei/.config/solana/id.json";
const journalDir = "/home/sergei/.local/share/yield-ai/seeker-devnet";
mkdirSync(journalDir, { recursive: true, mode: 0o700 });
const journalPath = join(journalDir, "cycle-2026-10-03.json");
if (existsSync(journalPath)) {
  const prior = JSON.parse(readFileSync(journalPath, "utf8"));
  assert(prior.status === "started" && prior.operations.length === 0, "Existing signed cycle journal: reconcile recorded signatures before any new send");
}
// WSL Node 20 cannot strip TypeScript; run the exact API core through a temporary ignored transpilation.
const cache = fileURLToPath(new URL("../node_modules/.cache/", import.meta.url)); mkdirSync(cache, { recursive: true });
const temp = mkdtempSync(join(cache, "yield-devnet-"));
const coreSource = readFileSync(new URL("../src/lib/mobileSafe.ts", import.meta.url), "utf8").replace('"../idl/yield_vault.json"', JSON.stringify(pathToFileURL(fileURLToPath(new URL("../src/idl/yield_vault.json", import.meta.url))).href));
const coreFile = join(temp, "mobileSafe.mjs");
const compiled = ts.transpileModule(coreSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
// Anchor's CJS BN export is not synthesized by Node 20 (the deployed server uses Node 24).
writeFileSync(coreFile, compiled.replace('import { BN, BorshAccountsCoder, BorshInstructionCoder } from "@coral-xyz/anchor";', 'import anchor from "@coral-xyz/anchor"; const { BN, BorshAccountsCoder, BorshInstructionCoder } = anchor;'));
const { MOBILE_NETWORKS, inspectSafe, creationPlan, usdcTransferPlan, safeAddresses } = await import(pathToFileURL(coreFile).href);
const n = MOBILE_NETWORKS.devnet;
const c = new Connection(process.env.V2_DEVNET_RPC_URL || "https://api.devnet.solana.com", { commitment: "confirmed", disableRetryOnRateLimit: true });
assert.equal(await c.getGenesisHash(), n.genesis);
const operator = new PublicKey("8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A");
const executor = new PublicKey("3ayNPp7MoihfbnTQ4q6Ge5PVNe9tJsY5betKqKX7C8aH");
const a = safeAddresses(operator, n);
const startingSol = await c.getBalance(operator, "finalized");
assert(startingSol > 30_000_000);
const journal = { cluster: "devnet", network: n, payer: String(operator), safe: String(a.safe), registry: String(a.registry), startingSolLamports: startingSol, operations: [], status: "started" };
function save() {
  const fd = openSync(journalPath + ".tmp", "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(journal, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(journalPath + ".tmp", journalPath);
  const dir = openSync(journalDir, "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
}
save();
let signer;
try {
  const secret = Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8")));
  try { signer = Keypair.fromSecretKey(Uint8Array.from(secret)); } finally { secret.fill(0); }
  assert(signer.publicKey.equals(operator));
  async function send(tx, label, height, maxCost) {
    assert.equal(tx.message.header.numRequiredSignatures, 1); assert(tx.message.staticAccountKeys[0].equals(operator));
    const fee = (await c.getFeeForMessage(tx.message, "confirmed")).value; assert.equal(fee, 5000);
    assert(maxCost <= 30_000_000);
    assert(startingSol - await c.getBalance(operator, "confirmed") + maxCost <= 30_000_000, "Aggregate authorized SOL ceiling exceeded");
    assert(await c.getBlockHeight("confirmed") <= height);
    tx.sign([signer]);
    const signed = await c.simulateTransaction(tx, { sigVerify: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: [String(operator)] } });
    assert.equal(signed.value.err, null, "Signed simulation rejected");
    assert(signed.value.accounts?.[0]);
    const payerBefore = await c.getBalance(operator, "confirmed");
    // Bank simulation already debits the signature fee from the payer account.
    const projectedCost = payerBefore - signed.value.accounts[0].lamports;
    assert(projectedCost >= fee && projectedCost <= maxCost, "Projected rent + fee exceeds reviewed amount");
    const signature = bs58.encode(tx.signatures[0]); const wire = Buffer.from(tx.serialize()).toString("base64");
    const op = { label, signature, lastValidBlockHeight: height, wireBase64: wire, status: "prepared", projectedCostLamports: projectedCost, unitsConsumed: signed.value.unitsConsumed };
    journal.operations.push(op); save();
    console.log(JSON.stringify({ label, status: "simulation_ok", signature, projectedCostLamports: projectedCost, unitsConsumed: signed.value.unitsConsumed }));
    assert.equal(await c.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 2 }), signature);
    op.status = "submitted"; save();
    let final;
    for (let i = 0; i < 100; i++) {
      const st = (await c.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (st) assert.equal(st.err, null, "Transaction failed: inspect journal");
      if (st?.confirmationStatus === "finalized") { final = st; break; }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    assert(final, "Confirmation unresolved: inspect journal; do not repeat");
    const receipt = await c.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    assert(receipt?.meta && !receipt.meta.err); assert.equal(receipt.meta.fee, 5000);
    const actual = receipt.meta.preBalances[0] - receipt.meta.postBalances[0]; assert(actual <= maxCost);
    Object.assign(op, { status: "finalized", slot: final.slot, actualFeeLamports: receipt.meta.fee, actualCostLamports: actual }); save();
    console.log(JSON.stringify({ label, status: "finalized", signature, slot: final.slot, actualCostLamports: actual }));
  }
  const existingRegistry = await c.getAccountInfo(a.registry, "finalized");
  if (!existingRegistry) {
    const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], a.program);
    const conf = await c.getAccountInfo(config, "finalized"); assert(conf?.owner.equals(a.program));
    assert(new BorshAccountsCoder(idl).decode("Config", conf.data).admin.equals(operator));
    const latest = await c.getLatestBlockhash();
    const ix = new TransactionInstruction({ programId: a.program, data: new BorshInstructionCoder(idl).encode("init_executor_registry", { default_executor: executor, approved: [executor] }), keys: [
      { pubkey: operator, isSigner: true, isWritable: true }, { pubkey: config, isSigner: false, isWritable: false }, { pubkey: a.registry, isSigner: false, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ] });
    const rent = await c.getMinimumBalanceForRentExemption(557);
    await send(new VersionedTransaction(new TransactionMessage({ payerKey: operator, recentBlockhash: latest.blockhash, instructions: [ix] }).compileToV0Message()), "init_registry", latest.lastValidBlockHeight, rent + 5000);
  }
  const initial = await inspectSafe(c, n, operator);
  assert(initial.defaultExecutor.equals(executor) && initial.defaultAvailable);
  assert.equal(initial.balanceUsdc, 0n, "Pilot Safe must be empty; do not withdraw unrelated funds");
  assert(initial.walletUsdc >= 1_000_000n);
  assert(initial.state.routePrincipalUsdc.every(x => x === "0.000000"));
  journal.walletBeforeRaw = String(initial.walletUsdc); save();
  const first = initial.state.exists ? await usdcTransferPlan(c, n, operator, "deposit", "1") : await creationPlan(c, n, operator, "1");
  assert.equal(first.status, "ready");
  await send(VersionedTransaction.deserialize(Buffer.from(first.steps[0].transaction, "base64")), initial.state.exists ? "deposit" : "create_and_deposit", first.lastValidBlockHeight, Number(first.cost.totalLamports));
  const deposited = await inspectSafe(c, n, operator); assert.equal(deposited.balanceUsdc, 1_000_000n); assert.equal(deposited.walletUsdc, initial.walletUsdc - 1_000_000n);
  for (const [amount, expected] of [["0.4", 600_000n], ["all", 0n]]) {
    const plan = await usdcTransferPlan(c, n, operator, "withdraw", amount);
    await send(VersionedTransaction.deserialize(Buffer.from(plan.steps[0].transaction, "base64")), amount === "all" ? "withdraw_all" : "withdraw_partial", plan.lastValidBlockHeight, Number(plan.cost.totalLamports));
    assert.equal((await inspectSafe(c, n, operator)).balanceUsdc, expected);
  }
  const after = await inspectSafe(c, n, operator); assert.equal(after.walletUsdc, initial.walletUsdc); assert.equal(after.balanceUsdc, 0n);
  const endingSol = await c.getBalance(operator, "finalized"); assert(startingSol - endingSol <= 30_000_000);
  Object.assign(journal, { status: "roundtrip_finalized_verified", walletAfterRaw: String(after.walletUsdc), safeAfterRaw: "0", totalCostLamports: startingSol - endingSol, completedAt: new Date().toISOString() }); save();
  const result = { ...journal, operations: journal.operations.map(({ wireBase64, ...op }) => op) };
  writeFileSync(new URL("../../docs/yield-ai-v2-seeker-devnet-result.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally { signer?.secretKey.fill(0); }
