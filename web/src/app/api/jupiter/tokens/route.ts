import { NextRequest, NextResponse } from "next/server";

const JUPITER_API_KEY = process.env.JUPITER_API_KEY || "";
const BASE = "https://api.jup.ag";

type TokenMeta = Record<string, unknown>;

type CacheEntry =
  | { kind: "hit"; value: TokenMeta; expiresAt: number }
  | { kind: "miss"; expiresAt: number };

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MISS_TTL_MS = 2 * 60 * 1000; // 2 minutes (avoid hammering unknown mints)

// Very small in-memory cache (per server instance).
const tokenCache = new Map<string, CacheEntry>();

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function fetchTokenWithRetry(
  mint: string,
  headers: Record<string, string>
): Promise<TokenMeta | null> {
  // A few quick retries for rate limiting / transient errors.
  const attempts = 3;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${BASE}/tokens/v2/search?query=${mint}`, {
        headers,
        // Avoid caching upstream in dev; we do our own cache.
        cache: "no-store",
      });

      if (res.status === 429) {
        // exponential-ish backoff
        await sleep(250 * (i + 1) * (i + 1));
        continue;
      }

      if (!res.ok) return null;

      const arr = await res.json();
      if (!Array.isArray(arr)) return null;
      const match = arr.find(
        (t: Record<string, unknown>) => t.id === mint || t.address === mint
      );
      return match ?? null;
    } catch {
      await sleep(150 * (i + 1));
    }
  }
  return null;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;

  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const current = idx++;
      if (current >= items.length) return;
      results[current] = await fn(items[current]!);
    }
  });

  await Promise.all(workers);
  return results;
}

export async function GET(req: NextRequest) {
  const ids = req.nextUrl.searchParams.get("ids");
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

  const headers: Record<string, string> = { "x-api-key": JUPITER_API_KEY };
  const result: Record<string, unknown> = {};

  const now = Date.now();
  const uncached: string[] = [];

  for (const mint of mints) {
    const entry = tokenCache.get(mint);
    if (entry && entry.expiresAt > now) {
      if (entry.kind === "hit") result[mint] = entry.value;
      continue;
    }
    uncached.push(mint);
  }

  // Limit concurrency to avoid rate limiting at api.jup.ag
  const CONCURRENCY = 5;
  await mapWithConcurrency(uncached, CONCURRENCY, async (mint) => {
    const meta = await fetchTokenWithRetry(mint, headers);
    if (meta) {
      result[mint] = meta;
      tokenCache.set(mint, {
        kind: "hit",
        value: meta,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
    } else {
      tokenCache.set(mint, { kind: "miss", expiresAt: Date.now() + MISS_TTL_MS });
    }
    return null;
  });

  return NextResponse.json({ data: result });
}
