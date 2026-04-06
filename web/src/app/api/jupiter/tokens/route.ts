import { NextRequest, NextResponse } from "next/server";

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "";
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const HELIUS_429_BACKOFF_MS = 800;

type TokenCacheEntry = {
  value: unknown;
  expiresAt: number;
};

const tokenCache = new Map<string, TokenCacheEntry>();
const inFlight = new Map<string, Promise<Record<string, unknown>>>();

export async function GET(req: NextRequest) {
  const ids = req.nextUrl.searchParams.get("ids");
  return fetchTokens(ids);
}

export async function POST(req: NextRequest) {
  try {
    const json = await req.json();
    const ids = Array.isArray(json.ids) ? json.ids.join(",") : json.ids;
    return fetchTokens(ids);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
}

async function fetchTokens(ids: string | null | undefined) {
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
    const entry = tokenCache.get(mint);
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
          const doFetch = async () =>
            fetch(RPC_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: "get-tokens",
                method: "getAssetBatch",
                params: { ids: uncached },
              }),
            });

          let response = await doFetch();
          if (response.status === 429) {
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
              out[asset.id] = {
                id: asset.id,
                address: asset.id,
                symbol:
                  asset.token_info?.symbol ||
                  asset.content?.metadata?.symbol ||
                  "UNKNOWN",
                name: asset.content?.metadata?.name || "Unknown Token",
                decimals: asset.token_info?.decimals || 0,
                logoURI:
                  asset.content?.links?.image || asset.content?.files?.[0]?.uri,
                icon:
                  asset.content?.links?.image || asset.content?.files?.[0]?.uri,
              };
            }
          }
          return out;
        })();

      inFlight.set(key, p);
      const fetched = await p.finally(() => inFlight.delete(key));

      for (const [mint, meta] of Object.entries(fetched)) {
        result[mint] = meta;
        tokenCache.set(mint, { value: meta, expiresAt: now + CACHE_TTL_MS });
      }
    } catch (err) {
      console.error("Helius Tokens API failed:", err);
    }
  }

  return NextResponse.json({ data: result });
}
