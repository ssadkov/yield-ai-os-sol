import test from "node:test";
import assert from "node:assert/strict";
import { normalizeKaminoYield, createKaminoYieldReader } from "../src/lib/kaminoYield.ts";
const vault = "91b1opzHNUQobfLZxGMNYT5qDRKoqV8FdsdQBmH4wBxy";
test("APY stays an exact decimal ratio; percentage scales once, absent history is null", () => {
  const y = normalizeKaminoYield({ apy: "0.07487914368164117", apy7d: "0.07636884526829812405" }, 1000, vault);
  assert.equal(y.apyPercent, "7.487914368164117");
  assert.equal(y.historicalApyRatio["7d"], "0.07636884526829812405");
  assert.equal(y.historicalApyRatio["24h"], null);
  assert.equal(y.sourceUpdatedAt, null); assert.equal(y.expiresAt, 61000);
  assert.equal(y.yieldAiPerformanceFeeIncluded, false); assert.equal(y.guaranteed, false);
});
test("zero and negative yield are distinct from missing or corrupt yield", () => {
  for (const apy of ["0", "-0.01"]) assert.equal(normalizeKaminoYield({ apy }, 0, vault).apyRatio, apy);
  for (const apy of [null, 0.07, "NaN", "Infinity", "7%", "1e999", "101", "-1.1", undefined]) assert.throws(() => normalizeKaminoYield({ apy }, 0, vault));
});
test("fresh cache coalesces requests; expired cache cannot conceal a failed refresh", async () => {
  let clock = 1000, calls = 0, fail = false;
  const read = createKaminoYieldReader(vault, async url => {
    assert.equal(url, `https://api.kamino.finance/kvaults/vaults/${vault}/metrics`);
    calls++; return fail ? new Response("no", { status: 503 }) : Response.json({ apy: "0.07" });
  }, () => clock);
  const [a,b] = await Promise.all([read(), read()]); assert.deepEqual(a,b); assert.equal(calls,1);
  clock = 60999; await read(); assert.equal(calls,1);
  clock = 61000; fail = true; await assert.rejects(read); assert.equal(calls,2);
  fail = false; assert.equal((await read()).fetchedAt, 61000); assert.equal(calls,3);
});
test("malformed JSON and oversized source responses never produce a rate", async () => {
  for (const body of ["oops", "x".repeat(65537)]) {
    const read = createKaminoYieldReader(vault, async () => new Response(body));
    await assert.rejects(read);
  }
});
