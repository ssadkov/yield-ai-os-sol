import { NextRequest, NextResponse } from "next/server";

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "";
const PRICE_CACHE_TTL_MS = 60 * 1000; // 1 minute
const HELIUS_429_BACKOFF_MS = 800;

type PriceCacheEntry = {
  value: unknown;
  expiresAt: number;
};

const priceCache = new Map<string, PriceCacheEntry>();
const inFlight = new Map<string, Promise<Record<string, unknown>>>();

export async function GET(req: NextRequest) {
  const ids = req.nextUrl.searchParams.get("ids");
  return fetchPrices(ids);
}

export async function POST(req: NextRequest) {
  try {
    const json = await req.json();
    const ids = Array.isArray(json.ids) ? json.ids.join(",") : json.ids;
    return fetchPrices(ids);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
}

async function fetchPrices(ids: string | null | undefined) {
  if (!ids) {
    return NextResponse.json({ error: "ids parameter required" }, { status: 400 });
  }

  const mints = ids
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (mints.length === 0) {
    return NextResponse.json({ data: {} });
  }

  const result: Record<string, unknown> = {};
  const uncached: string[] = [];
  const now = Date.now();

  for (const mint of mints) {
    const entry = priceCache.get(mint);
    if (entry && entry.expiresAt > now) {
      result[mint] = entry.value;
    } else {
      uncached.push(mint);
    }
  }

  if (uncached.length > 0) {
    try {
      if (!RPC_URL) throw new Error("Missing NEXT_PUBLIC_RPC_URL");

      const key = uncached.slice().sort().join(",");
      const p =
        inFlight.get(key) ??
        (async () => {
          // Use Helius getAssetBatch to fetch multiple prices at once
          const doFetch = async () =>
            fetch(RPC_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: "get-prices",
                method: "getAssetBatch",
                params: { ids: uncached },
              }),
            });

          let response = await doFetch();
          if (response.status === 429) {
            // Simple single retry with backoff to reduce burst collisions.
            await new Promise((r) => setTimeout(r, HELIUS_429_BACKOFF_MS));
            response = await doFetch();
          }

          if (!response.ok) return {};
          const json = await response.json();
          const heliusAssets = json.result;
          const out: Record<string, unknown> = {};

          if (Array.isArray(heliusAssets)) {
            for (const asset of heliusAssets) {
              if (!asset || !asset.id) continue;
              const priceInfo = asset.token_info?.price_info;
              if (priceInfo && priceInfo.price_per_token != null) {
                out[asset.id] = {
                  id: asset.id,
                  usdPrice: priceInfo.price_per_token,
                  price: priceInfo.price_per_token,
                  decimals: asset.token_info.decimals || 0,
                };
              }
            }
          }
          return out;
        })();

      inFlight.set(key, p);
      const fetched = await p.finally(() => inFlight.delete(key));

      for (const [mint, priceData] of Object.entries(fetched)) {
        result[mint] = priceData;
        priceCache.set(mint, { value: priceData, expiresAt: now + PRICE_CACHE_TTL_MS });
      }
    } catch (err) {
      console.error("Helius Prices API failed:", err);
    }
  }

  return NextResponse.json({ data: result });
}
