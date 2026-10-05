// Local server only. Mainnet reads + unsigned simulations; never sign/send.
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { checkedMobileTransaction } from "../src/lib/mobileSafeWallet.ts";
const base = process.env.MOBILE_TEST_BASE ?? "http://127.0.0.1:3304";
assert(["127.0.0.1", "localhost"].includes(new URL(base).hostname), "Use the local Mainnet server");
async function api(path, body, expected = 200) {
  const r = await fetch(`${base}/api/mobile/v1/${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  assert.equal(r.status, expected, `${path}: ${await r.clone().text()}`);
  assert.equal(r.headers.get("cache-control"), "no-store"); return r.json();
}
const config = await api("config");
assert.equal(config.network.cluster, "mainnet"); assert.equal(config.network.chain, "solana:mainnet");
assert.equal(config.capabilities.transactionSubmissionEnabled, false); assert.equal(config.capabilities.protocolDeposits, false);
const existingOwner = "EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2";
const newOwner = process.env.MOBILE_PROBE_OWNER ?? "8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A";
const state = await api(`safes?ownerType=solana&address=${existingOwner}&cluster=mainnet`);
assert.equal(state.safe, "FuDCEZBgp8gxP3gafnHbUJRgGW63VAmtZwsjus1U5qSZ"); assert.equal(state.exists, true); assert.equal(state.executorApproved, true);
const body = address => ({ cluster: "mainnet", owner: { type: "solana", address } });
const creation = await api("safes/creation-plan", body(newOwner));
if (creation.status === "ready") checkedMobileTransaction(creation, new PublicKey(newOwner), "create", "0", "mainnet");
else assert.equal(creation.status, "already_exists");
const repeat = await api("safes/creation-plan", { ...body(existingOwner), initialDepositUsdc: "1" });
assert.equal(repeat.status, "already_exists"); assert.deepEqual(repeat.steps, []);
const simulations = [];
for (const [action, amount, balance] of [["deposit", "0.000001", state.walletUsdc], ["withdraw", "0.000001", state.idleUsdc], ["withdraw", "all", state.idleUsdc]]) {
  if (Number(balance) === 0 && amount !== "all") continue;
  const plan = await api(`${action === "deposit" ? "deposits" : "withdrawals"}/plan`, { ...body(existingOwner), amount });
  if (plan.status === "ready") { checkedMobileTransaction(plan, new PublicKey(existingOwner), action, amount, "mainnet"); simulations.push({ action, requested: amount, amountRaw: plan.amountRaw, unitsConsumed: plan.simulation.unitsConsumed, feeLamports: plan.cost.networkFeeLamports }); }
  else assert.equal(plan.status, "empty");
}
for (const [path, payload, code] of [
  ["deposits/plan", { ...body(existingOwner), cluster: "devnet", amount: "1" }, "CLUSTER_MISMATCH"],
  ["withdrawals/plan", { ...body(existingOwner), recipient: newOwner, amount: "1" }, "INVALID_REQUEST"],
  ["deposits/plan", { ...body(existingOwner), amount: 1 }, "INVALID_AMOUNT"],
]) assert.equal((await api(path, payload, 400)).error.code, code);
const rpc = { jsonrpc: "2.0", id: 1, params: [], method: "getGenesisHash" };
assert.equal((await api("rpc", rpc)).result, config.network.genesis);
assert.equal((await api("rpc", { ...rpc, method: "sendTransaction", params: ["AA=="] }, 403)).error.code, "MAINNET_SEND_DISABLED");
assert.equal((await api("rpc", { ...rpc, method: "getProgramAccounts" }, 400)).error.code, "RPC_METHOD_NOT_ALLOWED");
for (const signature of ["4SyTHxyHo5NC9aqBJdoiHHaMVAqW1UGafLmhLocKAUaBKaczarbdMxrjNPwZcnZzBUcCpXWFtu31WYaem9pRpGS9", "2atdNN4G9FauvvuTqhQbhF4LkmV7Hq5ioA6K9YeAY1L79ZRRfBitjerrWcmo2YJwdXt1VfufsbEdLhur97bZG5sC"]) {
  const result = await api(`transactions/${signature}?cluster=mainnet`); assert.equal(result.status, "finalized"); assert.equal(result.error, null);
}
const page = await fetch(`${base}/v2/mobile`); assert.equal(page.status, 200); assert((await page.text()).includes("Mobile Safe pilot"));
console.log(JSON.stringify({ status: "mainnet_readonly_http_ok", network: config.network, safe: state.safe, idleUsdc: state.idleUsdc, walletUsdc: state.walletUsdc, executor: state.defaultExecutor, creation: { status: creation.status, safe: creation.state.safe, cost: creation.cost, simulation: creation.simulation }, simulations, oldReceipts: "finalized", submission: "disabled", signedTransactions: 0 }, null, 2));
