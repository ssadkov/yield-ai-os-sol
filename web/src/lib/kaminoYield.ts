import Decimal from "decimal.js";

const D = Decimal.clone({ precision: 50 });
const HISTORY = ["24h", "7d", "30d", "90d", "180d", "365d"] as const;
function ratio(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 80 || !/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  const number = new D(value);
  return number.isFinite() && number.gte(-1) && number.lte(100) ? number.toFixed() : null;
}
export function normalizeKaminoYield(payload: unknown, fetchedAt: number, vault: string) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid Kamino metrics");
  const data = payload as Record<string, unknown>;
  const apyRatio = ratio(data.apy);
  if (apyRatio === null) throw new Error("Missing or invalid Kamino APY");
  return {
    status: "available", strategy: "kamino_usdc", name: "Kamino Private Credit USDC", cluster: "mainnet", vault,
    rateType: "variable", apyRatio, apyPercent: new D(apyRatio).mul(100).toFixed(),
    historicalApyRatio: Object.fromEntries(HISTORY.map(period => [period, ratio(data[`apy${period}`])])),
    source: `https://api.kamino.finance/kvaults/vaults/${vault}/metrics`, sourceField: "apy",
    fetchedAt, sourceUpdatedAt: null, expiresAt: fetchedAt + 60_000,
    feeScope: "kamino_published", yieldAiPerformanceFeeIncluded: false, networkFeeIncluded: false,
    guaranteed: false,
  };
}
type YieldSnapshot = ReturnType<typeof normalizeKaminoYield>;
export function createKaminoYieldReader(vault: string, fetcher: typeof fetch = fetch, now: () => number = Date.now) {
  let cached: YieldSnapshot | undefined;
  let pending: Promise<YieldSnapshot> | undefined;
  return async function read(): Promise<YieldSnapshot> {
    if (cached && now() < cached.expiresAt) return cached;
    if (pending) return pending;
    pending = (async () => {
      const response = await fetcher(`https://api.kamino.finance/kvaults/vaults/${vault}/metrics`, {
        cache: "no-store", signal: AbortSignal.timeout(8_000), redirect: "error",
      });
      if (!response.ok) throw new Error("Kamino metrics unavailable");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Empty Kamino metrics");
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 65_536) { await reader.cancel(); throw new Error("Oversized Kamino metrics"); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      cached = normalizeKaminoYield(JSON.parse(Buffer.concat(chunks).toString("utf8")), now(), vault);
      return cached;
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}
