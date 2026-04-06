/**
 * Download icons for strategy tokens (ALL_TOKENS in server/agent/rebalance/tokens.ts).
 * Usage (from web/): node scripts/fetch-strategy-token-icons.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnv();

const BASE = "https://api.jup.ag";
const API_KEY = process.env.JUPITER_API_KEY || "";

/**
 * When Jupiter's icon URL is dead (404), try these after mint match.
 * Key = mint address.
 */
const ICON_FALLBACK_BY_MINT = {
  A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6: [
    "https://coin-images.coingecko.com/coins/images/31700/large/usdy_%281%29.png?1696530524",
  ],
};

/** Must match web/src/server/agent/rebalance/tokens.ts ALL_TOKENS */
const STRATEGY_TOKENS = [
  { symbol: "USDC", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  { symbol: "USDY", mint: "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6" },
  { symbol: "cbBTC", mint: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij" },
  { symbol: "SPYx", mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W" },
  { symbol: "XAUt0", mint: "AymATz4TCL9sWNEEV9Kvyz45CHVhDZ6kUgjTJPzLpU9P" },
  { symbol: "ONe", mint: "5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5" },
  { symbol: "JitoSOL", mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn" },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function jupiterSearchByMint(mint) {
  const url = new URL(`${BASE}/tokens/v2/search`);
  url.searchParams.set("query", mint);
  const res = await fetch(url.toString(), {
    headers: { "x-api-key": API_KEY },
  });
  if (res.status === 429) {
    const ra = Number(res.headers.get("Retry-After")) || 2;
    await sleep(ra * 1000);
    return jupiterSearchByMint(mint);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

function pickByMint(list, mint) {
  const found = list.find(
    (t) => (t.id || t.address || t.mint) === mint
  );
  return found || list[0] || null;
}

async function downloadIcon(url, destPath) {
  if (!url || !url.startsWith("http")) return false;
  const res = await fetch(url);
  if (!res.ok) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
  return true;
}

function extFromUrlOrContentType(url, contentType) {
  if (contentType?.includes("svg")) return ".svg";
  if (contentType?.includes("webp")) return ".webp";
  if (contentType?.includes("jpeg") || contentType?.includes("jpg")) return ".jpg";
  try {
    const p = new URL(url).pathname.split("/").pop() || "";
    const m = p.match(/\.(png|jpg|jpeg|webp|svg)$/i);
    if (m) return "." + m[1].toLowerCase();
  } catch {
    /* ignore */
  }
  return ".png";
}

async function main() {
  if (!API_KEY) {
    console.error("Missing JUPITER_API_KEY in web/.env");
    process.exit(1);
  }

  const outDir = path.join(__dirname, "..", "public", "token-catalog");
  const manifest = [];

  const RATE_MS = 1100;

  for (const { symbol, mint } of STRATEGY_TOKENS) {
    process.stdout.write(`Strategy ${symbol} (${mint.slice(0, 4)}…)… `);
    let data;
    try {
      data = await jupiterSearchByMint(mint);
    } catch (e) {
      console.log("error:", e.message);
      manifest.push({ symbol, mint, error: e.message });
      await sleep(RATE_MS);
      continue;
    }

    const list = Array.isArray(data) ? data : data.tokens || data.data || [];
    const token = pickByMint(list, mint);
    if (!token) {
      console.log("not found");
      manifest.push({ symbol, mint, error: "not_found" });
      await sleep(RATE_MS);
      continue;
    }

    const iconUrl =
      token.icon || token.logoURI || token.image || "";
    const safeSym = symbol.replace(/[^a-zA-Z0-9]/g, "_");
    const fileBase = `strat_${safeSym}_${mint.slice(0, 8)}`;

    let iconLocal = null;
    const tryDownload = async (url, baseName) => {
      try {
        const iconRes = await fetch(url, { signal: AbortSignal.timeout(60000) });
        if (!iconRes.ok) return null;
        const ct = iconRes.headers.get("content-type") || "";
        if (ct.includes("text/html")) return null;
        const buf = Buffer.from(await iconRes.arrayBuffer());
        if (buf.length < 200) return null;
        const ext = extFromUrlOrContentType(url, ct);
        const dest = path.join(outDir, `${baseName}${ext}`);
        fs.writeFileSync(dest, buf);
        return `/token-catalog/${path.basename(dest)}`;
      } catch {
        return null;
      }
    };

    if (iconUrl) {
      iconLocal = await tryDownload(iconUrl, fileBase);
    }
    if (!iconLocal && ICON_FALLBACK_BY_MINT[mint]) {
      for (const fallbackUrl of ICON_FALLBACK_BY_MINT[mint]) {
        const got = await tryDownload(fallbackUrl, fileBase);
        if (got) {
          iconLocal = got;
          break;
        }
      }
    }

    const entry = {
      symbol,
      mint,
      jupiterName: token.name,
      jupiterSymbol: token.symbol,
      iconUrl,
      iconLocal: iconLocal || null,
    };
    if (!entry.iconLocal && ICON_FALLBACK_BY_MINT[mint]?.length) {
      entry.iconFallbackTried = ICON_FALLBACK_BY_MINT[mint];
    }
    manifest.push(entry);
    console.log(iconLocal ? `ok → ${iconLocal}` : "no icon");
    await sleep(RATE_MS);
  }

  const manifestPath = path.join(__dirname, "..", "strategy-token-icons.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`\nWrote ${manifestPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
