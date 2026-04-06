export interface JupiterPriceEntry {
  usdPrice: number;
  decimals: number;
  liquidity?: number;
  priceChange24h?: number;
}

type CacheEntry<T> = { value: T; expiresAt: number };

const PRICE_TTL_MS = 60_000;
const META_TTL_MS = 10 * 60_000;

// Browser-side caches + singleflight to avoid bursts when multiple
// components request the same token batches simultaneously.
const priceCache = new Map<string, CacheEntry<JupiterPriceEntry>>();
const metaCache = new Map<string, CacheEntry<JupiterTokenInfo>>();
const inFlight = new Map<string, Promise<unknown>>();

// Soft client-side limiter to stay under free-tier RPC limits.
let lastRequestAtMs = 0;
async function clientThrottle(minSpacingMs: number) {
  if (typeof window === "undefined") return;
  const now = Date.now();
  const wait = lastRequestAtMs + minSpacingMs - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAtMs = Date.now();
}

function getApiBaseUrl(): string {
  // In the browser, relative URLs are correct.
  if (typeof window !== "undefined") return "";

  // On the server (Route Handlers, SSR), relative fetch() won't resolve.
  // Prefer an explicit app URL, otherwise fall back to Vercel, otherwise localhost.
  const explicit =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.APP_URL ||
    process.env.SITE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");

  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`.replace(/\/+$/, "");

  return "http://localhost:3000";
}

export async function fetchPrices(
  mintIds: string[]
): Promise<Record<string, JupiterPriceEntry>> {
  if (mintIds.length === 0) return {};

  const result: Record<string, JupiterPriceEntry> = {};
  const now = Date.now();
  const unique = Array.from(new Set(mintIds));

  const missing: string[] = [];
  for (const mint of unique) {
    const cached = priceCache.get(mint);
    if (cached && cached.expiresAt > now) result[mint] = cached.value;
    else missing.push(mint);
  }
  if (missing.length === 0) return result;

  const base = getApiBaseUrl();
  const batches: string[][] = [];
  // Use batches of 50 to avoid too large payloads or param limits
  for (let i = 0; i < missing.length; i += 50) {
    batches.push(missing.slice(i, i + 50));
  }

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const key = `prices:${batch.slice().sort().join(",")}`;
    try {
      const p =
        (inFlight.get(key) as Promise<Record<string, JupiterPriceEntry> | null> | undefined) ??
        (async () => {
          await clientThrottle(150);
          const res = await fetch(`${base}/api/jupiter/prices`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: batch }),
          });
          if (!res.ok) return null;
          return (await res.json()) as Record<string, JupiterPriceEntry>;
        })();
      inFlight.set(key, p);
      const json = await p.finally(() => inFlight.delete(key));
      if (!json) continue;
      
      // The new API v2 wraps prices in `data` field
      const data = "data" in json ? (json.data as unknown as Record<string, JupiterPriceEntry>) : json;
      
      for (const [mint, entry] of Object.entries(data)) {
        if (entry?.usdPrice != null) {
          result[mint] = entry;
          priceCache.set(mint, { value: entry, expiresAt: Date.now() + PRICE_TTL_MS });
        }
      }
    } catch {
      // price fetch failure is non-fatal
    }
  }

  return result;
}

export interface JupiterTokenInfo {
  id?: string;
  address?: string;
  symbol: string;
  name: string;
  decimals: number;
  icon?: string;
  logoURI?: string;
}

export async function fetchTokenMetadata(
  mintIds: string[]
): Promise<Record<string, JupiterTokenInfo>> {
  if (mintIds.length === 0) return {};

  const result: Record<string, JupiterTokenInfo> = {};
  const now = Date.now();
  const unique = Array.from(new Set(mintIds));

  const missing: string[] = [];
  for (const mint of unique) {
    const cached = metaCache.get(mint);
    if (cached && cached.expiresAt > now) result[mint] = cached.value;
    else missing.push(mint);
  }
  if (missing.length === 0) return result;

  const base = getApiBaseUrl();
  const batches: string[][] = [];
  for (let i = 0; i < missing.length; i += 50) {
    batches.push(missing.slice(i, i + 50));
  }

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const key = `tokens:${batch.slice().sort().join(",")}`;
    try {
      const p =
        (inFlight.get(key) as Promise<any> | undefined) ??
        (async () => {
          await clientThrottle(150);
          const res = await fetch(`${base}/api/jupiter/tokens`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: batch }),
          });
          if (!res.ok) return null;
          return await res.json();
        })();
      inFlight.set(key, p);
      const json = await p.finally(() => inFlight.delete(key));
      if (!json) continue;
      const data = json.data as Record<string, JupiterTokenInfo> | undefined;
      if (data && typeof data === "object") {
        for (const [mint, token] of Object.entries(data)) {
          if (token) {
            result[mint] = token;
            metaCache.set(mint, { value: token, expiresAt: Date.now() + META_TTL_MS });
          }
        }
      }
    } catch {
      // metadata fetch failure is non-fatal
    }
  }

  return result;
}

export function getTokenIcon(meta: JupiterTokenInfo | undefined): string | undefined {
  if (!meta) return undefined;
  return meta.icon || meta.logoURI || undefined;
}
