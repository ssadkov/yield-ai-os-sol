import Decimal from "decimal.js";

const D = Decimal.clone({ precision: 50 });
export const EXPONENT_YIELD_REFERENCE_RAW = "100000000"; // 100 USDC, six decimals
export const EXPONENT_YIELD_REFERENCE_USDC = "100";
export const EXPONENT_YIELD_MARKET = "onyc-10jan27";
export const EXPONENT_YIELD_MATURITY = 1799586000;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid Exponent quote");
  return value as Record<string, unknown>;
}
function raw(value: unknown): string {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) throw Error("Invalid Exponent amount");
  return value;
}
export function normalizeExponentYield(payload: unknown, fetchedAt: number) {
  const q = object(payload), input = object(q.input), preview = object(q.maturityPreview);
  if (q.market !== EXPONENT_YIELD_MARKET || q.action !== "buy" || q.asset !== "USDC"
    || q.owner !== null || q.authority !== null || input.raw !== EXPONENT_YIELD_REFERENCE_RAW
    || q.inputBasisUsdc !== EXPONENT_YIELD_REFERENCE_RAW || preview.displayProfitFeeBps !== 500
    || q.pilotFeeBps !== 0) throw Error("Unexpected Exponent reference quote");
  if (typeof q.chainTime !== "number" || !Number.isSafeInteger(q.chainTime) || q.chainTime <= 0
    || q.chainTime >= EXPONENT_YIELD_MATURITY || typeof q.expiresAt !== "number"
    || !Number.isSafeInteger(q.expiresAt) || q.expiresAt <= q.chainTime
    || q.expiresAt > q.chainTime + 90 || !Number.isSafeInteger(fetchedAt) || fetchedAt < 0
    || Math.abs(fetchedAt / 1000 - q.chainTime) > 90) throw Error("Expired or invalid Exponent quote");
  const expiresAt = Math.min(fetchedAt + 60_000, q.expiresAt * 1000, EXPONENT_YIELD_MATURITY * 1000);
  if (expiresAt <= fetchedAt) throw Error("Expired Exponent quote");
  const sourceApy = preview.netApyAfterCurrentDexAndFutureProfitFee;
  if (typeof sourceApy !== "string" || sourceApy.length > 100
    || !/^-?\d+(?:\.\d+)?(?:e[+-]?\d{1,3})?$/i.test(sourceApy)) throw Error("Invalid Exponent APY");
  const apy = new D(sourceApy);
  if (!apy.isFinite() || apy.lt(-1) || apy.gt(100)) throw Error("Invalid Exponent APY");
  const net = raw(preview.projectedNetUsdc), proceeds = raw(preview.usdcAtCurrentDexRaw);
  const fee = raw(preview.projectedFutureProfitFeeUsdc);
  if (BigInt(proceeds) - BigInt(fee) !== BigInt(net)) throw Error("Invalid Exponent net proceeds");
  const apr = new D(net).div(EXPONENT_YIELD_REFERENCE_RAW).minus(1)
    .mul(31_536_000).div(EXPONENT_YIELD_MATURITY - q.chainTime);
  if (typeof q.quoteId !== "string" || !/^[a-f0-9]{64}$/.test(q.quoteId)
    || typeof q.slot !== "string" || !/^\d+$/.test(q.slot)
    || typeof preview.assumption !== "string") throw Error("Invalid Exponent quote metadata");
  return {
    status: "available", strategy: "exponent_onyc_10jan27", market: EXPONENT_YIELD_MARKET,
    name: "Exponent PT-ONyc 10 Jan 2027", cluster: "mainnet",
    rateType: "fixed_maturity_preview", referenceAmountUsdc: EXPONENT_YIELD_REFERENCE_USDC,
    apyRatio: apy.toFixed(), apyPercent: apy.mul(100).toFixed(),
    aprRatio: apr.toFixed(), aprPercent: apr.mul(100).toFixed(),
    maturity: new Date(EXPONENT_YIELD_MATURITY * 1000).toISOString(),
    fetchedAt, expiresAt, chainTimeUnixSeconds: q.chainTime, slot: q.slot, quoteId: q.quoteId,
    source: "Exponent CLMM and Orca ONyc/USDC live buy quote",
    sourceField: "maturityPreview.netApyAfterCurrentDexAndFutureProfitFee",
    projectedNetUsdc: new D(net).div(1_000_000).toFixed(),
    projectedFutureProfitFeeUsdc: new D(fee).div(1_000_000).toFixed(),
    feeScope: "current_dex_and_projected_future_profit_fee",
    displayProfitFeeBps: 500, pilotProfitFeeBps: 0,
    networkFeeIncluded: false, rentIncluded: false,
    indicative: true, guaranteed: false, assumption: preview.assumption,
  };
}
export type ExponentYieldSnapshot = ReturnType<typeof normalizeExponentYield>;
export function createExponentYieldReader(loadQuote: () => Promise<unknown>, now: () => number = Date.now) {
  let cached: ExponentYieldSnapshot | undefined;
  let pending: Promise<ExponentYieldSnapshot> | undefined;
  return async function read(): Promise<ExponentYieldSnapshot> {
    if (cached && now() < cached.expiresAt) return cached;
    if (pending) return pending;
    pending = (async () => {
      const snapshot = normalizeExponentYield(await loadQuote(), now());
      cached = snapshot;
      return snapshot;
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}
