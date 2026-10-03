import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VersionedTransaction } from "@solana/web3.js";
const base = process.env.V2_LOCAL_API_ORIGIN || "http://127.0.0.1:3303";
assert(["localhost", "127.0.0.1"].includes(new URL(base).hostname), "Probe is for the local server only");
const evidence = JSON.parse(readFileSync(new URL("../../docs/yield-ai-v2-seeker-devnet-result.json", import.meta.url)));
async function api(path, body, expected = 200) {
  const response = await fetch(`${base}/api/mobile/v1/${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  assert.equal(response.status, expected); assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json();
}
const config = await api("config"); assert.equal(config.network.cluster, "devnet"); assert.equal(config.capabilities.createAndDeposit, true);
assert.equal(config.capabilities.protocolDeposits, false);
const body = { owner: { type: "solana", address: evidence.payer }, cluster: "devnet" };
const state = await api(`safes?ownerType=solana&address=${evidence.payer}&cluster=devnet`);
assert.equal(state.safe, evidence.safe); assert.equal(state.idleUsdc, "0.000000"); assert.equal(state.executorApproved, true);
const repeat = await api("safes/creation-plan", { ...body, initialDepositUsdc: "1" }); assert.equal(repeat.status, "already_exists"); assert.equal(repeat.steps.length, 0);
const deposit = await api("deposits/plan", { ...body, amount: "1" }); assert.equal(deposit.status, "ready"); assert.equal(deposit.amountRaw, "1000000");
const tx = VersionedTransaction.deserialize(Buffer.from(deposit.steps[0].transaction, "base64")); assert.equal(tx.message.header.numRequiredSignatures, 1); assert(tx.signatures[0].every(b => b === 0));
const empty = await api("withdrawals/plan", { ...body, amount: "all" }); assert.equal(empty.status, "empty");
for (const op of evidence.operations) {
  const st = await api(`transactions/${op.signature}?cluster=devnet&lastValidBlockHeight=${op.lastValidBlockHeight}`);
  assert.equal(st.status, "finalized"); assert.equal(st.error, null);
}
assert.equal((await api("deposits/plan", { ...body, cluster: "mainnet", amount: "1" }, 400)).error.code, "CLUSTER_MISMATCH");
assert.equal((await api("withdrawals/plan", { ...body, amount: "1", recipient: evidence.payer }, 400)).error.code, "INVALID_REQUEST");
assert.equal((await api("transactions/bad?cluster=devnet", null, 400)).error.code, "INVALID_SIGNATURE");
const page = await fetch(`${base}/v2/devnet`); assert.equal(page.status, 200); assert((await page.text()).includes("Devnet Safe test"));
console.log(JSON.stringify({ status: "devnet_http_probe_ok", creationRetry: "no_steps", deposit: "unsigned_simulated_not_sent", finalizedReceipts: evidence.operations.length, safeUsdc: state.idleUsdc, registry: "ready", testPage: "200" }));
