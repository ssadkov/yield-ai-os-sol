/**
 * Fetches token metadata from Jupiter Tokens API v2 (search) and downloads icons.
 * Usage (from web/): node scripts/fetch-token-catalog.mjs
 * Requires JUPITER_API_KEY in .env
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
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

const CATALOG = {
  Blockchain: [
    "SOL",
    "HYPE",
    "ZEC",
    "TRX",
    "cbBTC",
    "WETH",
  ],
  "Solana ecosystem": ["PUMP", "JUP", "PYTH", "RAY", "JTO", "KMNO", "SKR"],
  xStocks: [
    "CRCLx",
    "TSLAx",
    "NVDAx",
    "SPYx",
    "GOOGLx",
    "AAPLx",
    "METAx",
    "MCDx",
  ],
  Gold: ["XAUt0"],
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function jupiterSearch(query) {
  const url = new URL(`${BASE}/tokens/v2/search`);
  url.searchParams.set("query", query);
  const res = await fetch(url.toString(), {
    headers: { "x-api-key": API_KEY },
  });
  if (res.status === 429) {
    const ra = res.headers.get("Retry-After");
    const wait = (Number(ra) || 2) * 1000;
    console.warn(`429 on ${query}, sleeping ${wait}ms`);
    await sleep(wait);
    return jupiterSearch(query);
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`search ${query}: HTTP ${res.status} ${t}`);
  }
  return res.json();
}

function pickBest(results, wantedSymbol) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const want = wantedSymbol.toUpperCase();
  const candidates = results.filter(
    (t) => (t.symbol || "").toUpperCase() === want
  );
  const pool = candidates.length > 0 ? candidates : results;

  const score = (t) => {
    let s = 0;
    if (t.isVerified) s += 1e9;
    if (t.organicScore != null) s += Number(t.organicScore) || 0;
    if (t.liquidity != null) s += Math.log10(Number(t.liquidity) + 1) * 1e6;
    if (t.mcap != null) s += Math.log10(Number(t.mcap) + 1) * 1e3;
    return s;
  };

  return pool.slice().sort((a, b) => score(b) - score(a))[0];
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

async function main() {
  if (!API_KEY) {
    console.error("Missing JUPITER_API_KEY in web/.env");
    process.exit(1);
  }

  const outDir = path.join(__dirname, "..", "public", "token-catalog");
  fs.mkdirSync(outDir, { recursive: true });

  const flat = [];
  const RATE_MS = 1100;

  for (const [category, symbols] of Object.entries(CATALOG)) {
    for (const sym of symbols) {
      process.stdout.write(`Searching ${sym}... `);
      let data;
      try {
        data = await jupiterSearch(sym);
      } catch (e) {
        console.error(e.message);
        flat.push({
          category,
          query: sym,
          error: e.message,
        });
        await sleep(RATE_MS);
        continue;
      }

      const list = Array.isArray(data) ? data : data?.tokens || data?.data || [];
      const best = pickBest(list, sym);
      if (!best) {
        console.log("no results");
        flat.push({ category, query: sym, error: "no_results" });
        await sleep(RATE_MS);
        continue;
      }

      const mint = best.id || best.address || best.mint;
      const iconUrl =
        best.icon ||
        best.logoURI ||
        best.image ||
        best?.content?.links?.image ||
        "";

      const safeFile = `${sym.replace(/[^a-zA-Z0-9]/g, "_")}_${String(mint).slice(0, 8)}`;
      let ext = ".png";
      try {
        const u = new URL(iconUrl);
        const pathPart = u.pathname.split("/").pop() || "";
        const m = pathPart.match(/\.(png|jpg|jpeg|webp|gif)$/i);
        if (m) ext = "." + m[1].toLowerCase();
      } catch {
        /* default .png */
      }
      const localPath = `/token-catalog/${safeFile}${ext}`;
      const diskPath = path.join(outDir, `${safeFile}${ext}`);

      let iconSaved = false;
      if (iconUrl) {
        try {
          iconSaved = await downloadIcon(iconUrl, diskPath);
        } catch {
          iconSaved = false;
        }
      }

      const row = {
        category,
        query: sym,
        mint,
        symbol: best.symbol,
        name: best.name,
        decimals: best.decimals,
        isVerified: best.isVerified ?? null,
        organicScore: best.organicScore ?? null,
        iconUrl,
        iconLocal: iconSaved ? localPath : null,
      };

      flat.push(row);
      console.log(`${best.symbol} — ${best.name} (${mint})`);
      await sleep(RATE_MS);
    }
  }

  const jsonPath = path.join(__dirname, "..", "src", "config", "token-catalog.json");
  fs.writeFileSync(jsonPath, JSON.stringify(flat, null, 2), "utf8");
  console.log(`\nWrote ${jsonPath}`);
  console.log(`Icons under ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
