/** One bounded new-owner Devnet deposit. Session permits Devnet sends; protected signer stays in WSL. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, fsyncSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import bs58 from "bs58";
assert.equal(process.platform, "linux", "Protected WSL operator runtime required");
assert.equal(process.env.V2_EVM_DEPOSIT_ACK, "DEVNET_NEW_OWNER_ONE_USDC_DEPOSIT");
assert(process.argv.includes("--send-reviewed"));
const journalPath = fileURLToPath(new URL("../../target/deploy/evm-new-owner-recovery-deposit-journal.json", import.meta.url));
assert(!existsSync(journalPath), "Prior deposit journal exists: inspect its signature before any repeat");
const { transaction, result, rpc, source, destination, safe, payer, vault, s, d, amount } = await import("./v2-evm-new-owner-deposit-preflight.mjs");
assert.equal(result.status, "deposit_preflight_ok"); assert.equal(amount, 1000000n);
assert.equal(result.feeLamports, 5000); assert.equal(result.rentLamports, 0);
const endpoint = process.env.V2_DEVNET_RPC_URL || "https://api.devnet.solana.com";
let id = 0;
async function operatorRpc(method, params) {
  assert(["sendTransaction", "getSignatureStatuses", "getTransaction", "getMultipleAccounts"].includes(method));
  const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(60000) });
  assert(response.ok, "RPC HTTP " + response.status + "; inspect journal before retry");
  const body = await response.json(); assert(!body.error, method + " RPC error; inspect journal before retry"); return body.result;
}
// This invocation is explicitly authorized for the existing protected operator signer. No key is copied or exposed.
assert.equal(process.env.V2_PAYER_KEYPAIR, "/home/sergei/.config/solana/id.json");
let signer;
try { const secret = Uint8Array.from(JSON.parse(readFileSync(process.env.V2_PAYER_KEYPAIR, "utf8"))); signer = Keypair.fromSecretKey(Uint8Array.from(secret)); secret.fill(0); }
catch { throw Error("Cannot load protected operator signer"); }
try {
assert(signer.publicKey.equals(payer), "operator signer mismatch");
transaction.sign(signer);
const wire = transaction.serialize().toString("base64"), signature = bs58.encode(transaction.signature);
const sim = (await rpc("simulateTransaction", [wire, { encoding: "base64", sigVerify: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: [source.toBase58(), destination.toBase58(), safe.toBase58()] } }])).value;
assert.equal(sim.err, null, "signed deposit simulation failed");
function decode(a) { assert(a); return { ...a, owner: new PublicKey(a.owner), data: Buffer.from(a.data[0], "base64") }; }
const projected = sim.accounts.map(decode);
assert.equal(unpackAccount(source, projected[0], TOKEN_PROGRAM_ID).amount, s.amount - amount);
assert.equal(unpackAccount(destination, projected[1], TOKEN_PROGRAM_ID).amount, d.amount + amount);
assert(projected[2].data.equals(vault.data));
console.log(JSON.stringify({ status: "signed_deposit_simulation_ok", cluster: "devnet", signature, amountRaw: amount.toString(), feeLamports: 5000, rentLamports: 0, simulationError: sim.err, computeUnits: sim.unitsConsumed }));
const journal = { ...result, signature, status: "prepared", preparedAt: new Date().toISOString(), transactionSent: false, wireBase64: wire };
function save() { const fd = openSync(journalPath + ".tmp", "w", 0o600); try { writeFileSync(fd, JSON.stringify(journal, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); } renameSync(journalPath + ".tmp", journalPath); const dir = openSync(fileURLToPath(new URL("../../target/deploy/", import.meta.url)), "r"); try { fsyncSync(dir); } finally { closeSync(dir); } }
save(); // Reserve exact signature before send; an uncertain send can never trigger an automatic new deposit.
const returned = await operatorRpc("sendTransaction", [wire, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 2 }]);
assert.equal(returned, signature); journal.status = "submitted"; journal.transactionSent = true; save();
console.log(JSON.stringify({ status: "deposit_submitted", signature }));
let finalized;
for (let n = 0; n < 90; n++) {
  const st = (await operatorRpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }])).value[0];
  if (st) assert.equal(st.err, null, "deposit failed; inspect signature");
  if (st?.confirmationStatus === "finalized") { finalized = st; break; }
  await new Promise(resolve => setTimeout(resolve, 1500));
}
assert(finalized, "confirmation unresolved; inspect journal, do not repeat deposit");
journal.status = "finalized"; journal.finalizedSlot = finalized.slot; save();
console.log(JSON.stringify({ status: "deposit_finalized", signature, slot: finalized.slot }));
const receipt = await operatorRpc("getTransaction", [signature, { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 }]);
assert(receipt && receipt.meta && !receipt.meta.err); assert.equal(receipt.meta.fee, 5000);
const state = await operatorRpc("getMultipleAccounts", [[source.toBase58(), destination.toBase58(), safe.toBase58()], { commitment: "finalized", encoding: "base64", minContextSlot: finalized.slot }]);
const post = state.value.map(decode);
const sourceAfter = unpackAccount(source, post[0], TOKEN_PROGRAM_ID).amount;
const destinationAfter = unpackAccount(destination, post[1], TOKEN_PROGRAM_ID).amount;
assert.equal(sourceAfter, s.amount - amount); assert.equal(destinationAfter, d.amount + amount); assert(post[2].data.equals(vault.data));
Object.assign(journal, { status: "deposit_finalized_verified", verifiedAt: new Date().toISOString(), readbackSlot: state.context.slot, actualFeeLamports: receipt.meta.fee, sourceAfterRaw: sourceAfter.toString(), destinationAfterRaw: destinationAfter.toString(), safeNonceAfter: "1", safeDataUnchanged: true }); save();
const { wireBase64, ...publicResult } = journal;
writeFileSync(new URL("../../docs/yield-ai-v2-evm-new-owner-deposit-result.json", import.meta.url), JSON.stringify(publicResult, null, 2) + "\n");
console.log(JSON.stringify(publicResult, null, 2));
} finally { signer.secretKey.fill(0); }
