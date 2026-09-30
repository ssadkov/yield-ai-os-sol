// Local HTTP integration checks. Start the API with V2_MOBILE_CLUSTER=mainnet.
// All requests only read/build/simulate. No signed transaction is sent.
import test from "node:test";
import assert from "node:assert/strict";
const base = process.env.MOBILE_TEST_BASE ?? "http://127.0.0.1:3231/api/mobile/v1";
const owner = "8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A";
const body = { cluster: "mainnet", owner: { type: "solana", address: owner } };
const post = (data) => fetch(`${base}/safes/creation-plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof data === "string" ? data : JSON.stringify(data) });

test("HTTP config, owner Safe state and unsigned creation plan", async () => {
  const configResponse = await fetch(`${base}/config`);
  assert.equal(configResponse.status, 200);
  assert.equal(configResponse.headers.get("cache-control"), "no-store");
  const config = await configResponse.json();
  assert.equal(config.network.cluster, "mainnet");
  assert.deepEqual(config.supportedOwnerTypes, ["solana"]);
  assert.equal(config.capabilities.deposits, true);
  assert.equal(config.capabilities.withdrawals, true);
  assert.equal(config.capabilities.protocolDeposits, false);
  const stateResponse = await fetch(`${base}/safes?ownerType=solana&cluster=mainnet&address=EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2`);
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.safe, "FuDCEZBgp8gxP3gafnHbUJRgGW63VAmtZwsjus1U5qSZ");
  assert.equal(state.exists, true);
  const response = await post(body);
  assert.equal(response.status, 200);
  const plan = await response.json();
  assert.equal(plan.status, "ready"); assert.equal(plan.steps.length, 1);
  assert.equal(plan.cost.feePayer, owner);
  assert.ok(plan.simulation.unitsConsumed > 0);
});
test("HTTP deposit, partial and all-idle withdrawal are unsigned and owner-bound", async () => {
  const transferBody = { cluster: "mainnet", owner: { type: "solana", address: "EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2" }, amount: "1.000000" };
  for (const [route, amount] of [["deposits", "1.000000"], ["withdrawals", "1.000000"], ["withdrawals", "all"]]) {
    const response = await fetch(`${base}/${route}/plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...transferBody, amount }) });
    assert.equal(response.status, 200);
    const plan = await response.json();
    assert.equal(plan.status, "ready"); assert.equal(plan.steps.length, 1);
    assert.equal(plan.scope, "idle_usdc"); assert.equal(plan.cost.feePayer, transferBody.owner.address);
    assert.equal(plan.destination, route === "deposits" ? plan.state.usdcAta : plan.state.ownerUsdcAta);
    assert.ok(plan.simulation.unitsConsumed > 0);
  }
  for (const [route, data, status, code] of [
    ["deposits", { ...transferBody, amount: "all" }, 400, "INVALID_AMOUNT"],
    ["withdrawals", { ...transferBody, recipient: owner }, 400, "INVALID_REQUEST"],
    ["deposits", { ...transferBody, amount: 1 }, 400, "INVALID_AMOUNT"],
    ["withdrawals", { ...transferBody, amount: "1.0000001" }, 400, "INVALID_AMOUNT"],
    ["withdrawals", { ...transferBody, amount: "18446744073709.551615" }, 422, "INSUFFICIENT_USDC"],
  ]) {
    const response = await fetch(`${base}/${route}/plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    assert.equal(response.status, status); assert.equal((await response.json()).error.code, code);
  }
});
test("HTTP rejects EVM, cluster mismatch, arbitrary fields, malformed JSON and oversized bodies", async () => {
  for (const [data, status, code] of [
    [{ ...body, cluster: "devnet" }, 400, "CLUSTER_MISMATCH"],
    [{ ...body, owner: { type: "evm", address: "0x70d5d723Ba7f39Cfb676C67Bbd4b5D6aE8047f4B" } }, 400, "UNSUPPORTED_OWNER_TYPE"],
    [{ ...body, executor: "override" }, 400, "INVALID_REQUEST"],
    ["invalid JSON", 400, "INVALID_REQUEST"],
    ["x".repeat(2049), 413, "INVALID_REQUEST"],
  ]) {
    const response = await post(data);
    assert.equal(response.status, status);
    const error = (await response.json()).error;
    assert.equal(error.code, code);
    assert.doesNotMatch(JSON.stringify(error), /api-key|Authorization|Bearer/);
  }
});
