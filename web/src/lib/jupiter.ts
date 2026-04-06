export interface JupiterPriceEntry {
  usdPrice: number;
  decimals: number;
  liquidity?: number;
  priceChange24h?: number;
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
  const base = getApiBaseUrl();
  const batches: string[][] = [];
  // Use batches of 50 to avoid too large payloads or param limits
  for (let i = 0; i < mintIds.length; i += 50) {
    batches.push(mintIds.slice(i, i + 50));
  }

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    try {
      const res = await fetch(`${base}/api/jupiter/prices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: batch }),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as Record<string, JupiterPriceEntry>;
      
      // The new API v2 wraps prices in `data` field
      const data = "data" in json ? (json.data as unknown as Record<string, JupiterPriceEntry>) : json;
      
      for (const [mint, entry] of Object.entries(data)) {
        if (entry?.usdPrice != null) {
          result[mint] = entry;
        }
      }
    } catch {
      // price fetch failure is non-fatal
    }
    
    // Sleep to respect the 1 request per second API rate limit on free tier
    if (i < batches.length - 1) {
      await new Promise(r => setTimeout(r, 1100));
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
  const base = getApiBaseUrl();
  const batches: string[][] = [];
  for (let i = 0; i < mintIds.length; i += 50) {
    batches.push(mintIds.slice(i, i + 50));
  }

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    try {
      const res = await fetch(`${base}/api/jupiter/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: batch }),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const data = json.data as Record<string, JupiterTokenInfo> | undefined;
      if (data && typeof data === "object") {
        for (const [mint, token] of Object.entries(data)) {
          if (token) {
            result[mint] = token;
          }
        }
      }
    } catch {
      // metadata fetch failure is non-fatal
    }
    
    // Sleep to respect the API rate limit context
    if (i < batches.length - 1) {
      await new Promise(r => setTimeout(r, 1100));
    }
  }

  return result;
}

export function getTokenIcon(meta: JupiterTokenInfo | undefined): string | undefined {
  if (!meta) return undefined;
  return meta.icon || meta.logoURI || undefined;
}
