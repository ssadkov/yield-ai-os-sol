import { NextRequest, NextResponse } from "next/server";

const JUPITER_API_KEY = process.env.JUPITER_API_KEY || "";
const BASE = "https://api.jup.ag";

const PRICE_CACHE_TTL_MS = 60 * 1000; // 1 minute

type PriceCacheEntry = {
  value: unknown;
  expiresAt: number;
};

const priceCache = new Map<string, PriceCacheEntry>();

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
      const headers: Record<string, string> = {};
      if (JUPITER_API_KEY) {
        headers["x-api-key"] = JUPITER_API_KEY;
      }

      const uncachedIds = uncached.join(",");
      const res = await fetch(`${BASE}/price/v3?ids=${uncachedIds}`, { headers });
      
      if (res.ok) {
        const json = await res.json();
        // Supports both raw and data-wrapped endpoints from Jupiter
        const fetchedPrices = "data" in json ? json.data : json;
        
        for (const [mint, priceData] of Object.entries(fetchedPrices as Record<string, unknown>)) {
          if (priceData) {
            result[mint] = priceData;
            priceCache.set(mint, {
              value: priceData,
              expiresAt: now + PRICE_CACHE_TTL_MS,
            });
          }
        }
      } else {
        console.error("Jupiter Prices API responded with error:", res.status, await res.text());
      }
    } catch (err) {
      console.error("Jupiter Prices API failed:", err);
    }
  }

  return NextResponse.json({ data: result });
}
