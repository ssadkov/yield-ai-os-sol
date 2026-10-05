import test from "node:test";
import assert from "node:assert/strict";
import Decimal from "decimal.js";
import { normalizeExponentYield, createExponentYieldReader, EXPONENT_YIELD_MATURITY } from "../src/lib/exponentYield.ts";

const now = 1791189000000;
const fixture = () => ({
  market: "onyc-10jan27", action: "buy", asset: "USDC", owner: null, authority: null,
  input: { raw: "100000000" }, inputBasisUsdc: "100000000", pilotFeeBps: 0,
  chainTime: now / 1000, expiresAt: now / 1000 + 90, slot: "12345", quoteId: "a".repeat(64),
  maturityPreview: { displayProfitFeeBps: 500, projectedNetUsdc: "101900000",
    usdcAtCurrentDexRaw: "102000000", projectedFutureProfitFeeUsdc: "100000",
    netApyAfterCurrentDexAndFutureProfitFee: "0.07487914368164117",
    assumption: "Current NAV and current DEX liquidity; maturity NAV, liquidity and fees are unknown" },
});
test("APY is exactly the ownerless buy quote rate; APR uses simple annualization of net proceeds", () => {
  const y = normalizeExponentYield(fixture(), now);
  assert.equal(y.apyRatio, "0.07487914368164117"); assert.equal(y.apyPercent, "7.487914368164117");
  assert(new Decimal(y.aprRatio).minus(new Decimal("0.019").mul(31536000).div(EXPONENT_YIELD_MATURITY-now/1000)).abs().lt("1e-19"));
  assert.equal(y.projectedNetUsdc, "101.9"); assert.equal(y.projectedFutureProfitFeeUsdc, "0.1");
  assert.equal(y.maturity, "2027-01-10T13:00:00.000Z"); assert.equal(y.expiresAt, now+60000);
  assert.equal(y.referenceAmountUsdc, "100"); assert.equal(y.pilotProfitFeeBps, 0);
  assert.equal(y.guaranteed, false); assert.equal(y.networkFeeIncluded, false);
});
test("owner-specific quotes, wrong amount, market, asset and fee policy are never reference rates", () => {
  for (const change of [{owner:"someone"}, {authority:"someone"}, {market:"other"}, {action:"sell"},
    {asset:"ONYC"}, {input:{raw:"1000000"}}, {inputBasisUsdc:"1"}, {pilotFeeBps:500}])
    assert.throws(() => normalizeExponentYield({...fixture(), ...change}, now));
  const q=fixture(); q.maturityPreview.displayProfitFeeBps=0;
  assert.throws(() => normalizeExponentYield(q, now));
});
test("zero and negative rates are returned, missing or nonfinite rates are rejected", () => {
  for (const rate of ["0","-0.01","7e-2"]) {
    const q=fixture(); q.maturityPreview.netApyAfterCurrentDexAndFutureProfitFee=rate;
    assert.equal(normalizeExponentYield(q,now).apyRatio,new Decimal(rate).toFixed());
  }
  for (const rate of [null,0.07,"NaN","Infinity","7%","1e999","101","-1.01",undefined]) {
    const q=fixture(); q.maturityPreview.netApyAfterCurrentDexAndFutureProfitFee=rate;
    assert.throws(() => normalizeExponentYield(q,now));
  }
});
test("expiry uses milliseconds, caps to actual quote deadline and rejects maturity or stale clocks", () => {
  const q=fixture(); q.expiresAt=now/1000+10;
  assert.equal(normalizeExponentYield(q,now).expiresAt,now+10000);
  for(const change of [{expiresAt:now/1000}, {expiresAt:now/1000+1000},
    {chainTime:EXPONENT_YIELD_MATURITY}, {chainTime:now/1000-91}])
    assert.throws(() => normalizeExponentYield({...fixture(),...change},now));
  assert.throws(() => normalizeExponentYield(q,now+10000));
});
test("malformed net amounts or quote metadata cannot produce displayable rates", () => {
  for(const field of ["projectedNetUsdc","usdcAtCurrentDexRaw","projectedFutureProfitFeeUsdc"]) {
    const q=fixture(); q.maturityPreview[field]="-1";
    assert.throws(() => normalizeExponentYield(q,now));
  }
  const q=fixture(); q.maturityPreview.projectedNetUsdc="101";
  assert.throws(() => normalizeExponentYield(q,now));
  assert.throws(() => normalizeExponentYield({...fixture(),quoteId:"bad"},now));
  assert.throws(() => normalizeExponentYield({...fixture(),maturityPreview:null},now));
});
test("cache coalesces calls, refreshes at quote expiry and never falls back to expired yield", async () => {
  let clock=now, calls=0, fail=false;
  const read=createExponentYieldReader(async()=>{
    calls++; if(fail)throw Error("RPC private URL must not leak");
    const q=fixture(); q.chainTime=clock/1000; q.expiresAt=clock/1000+90; return q;
  },()=>clock);
  const [a,b]=await Promise.all([read(),read()]); assert.deepEqual(a,b); assert.equal(calls,1);
  clock=now+59999; await read(); assert.equal(calls,1);
  clock=now+60000; fail=true; await assert.rejects(read); assert.equal(calls,2);
  fail=false; assert.equal((await read()).fetchedAt,clock); assert.equal(calls,3);
});
