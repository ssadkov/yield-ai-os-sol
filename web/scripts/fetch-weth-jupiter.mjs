/**
 * One-off: resolve WETH by mint from Jupiter and download icon.
 * Usage: node scripts/fetch-weth-jupiter.mjs
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

const MINT = "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs";
const API_KEY = process.env.JUPITER_API_KEY || "";

async function main() {
  if (!API_KEY) {
    console.error("Missing JUPITER_API_KEY");
    process.exit(1);
  }

  const url = new URL("https://api.jup.ag/tokens/v2/search");
  url.searchParams.set("query", MINT);

  const res = await fetch(url.toString(), {
    headers: { "x-api-key": API_KEY },
  });
  if (!res.ok) {
    console.error(await res.text());
    process.exit(1);
  }
  const data = await res.json();
  const list = Array.isArray(data) ? data : data.tokens || data.data || [];
  const token =
    list.find((t) => (t.id || t.address || t.mint) === MINT) || list[0];

  if (!token) {
    console.error("No token found for mint");
    process.exit(1);
  }

  const iconUrl =
    token.icon || token.logoURI || token.image || "";
  const outDir = path.join(__dirname, "..", "public", "token-catalog");
  fs.mkdirSync(outDir, { recursive: true });

  let iconLocal = null;
  if (iconUrl && iconUrl.startsWith("http")) {
    const iconRes = await fetch(iconUrl);
    if (iconRes.ok) {
      const buf = Buffer.from(await iconRes.arrayBuffer());
      let ext = ".png";
      const ct = iconRes.headers.get("content-type") || "";
      if (ct.includes("svg")) ext = ".svg";
      else if (ct.includes("webp")) ext = ".webp";
      else if (ct.includes("jpeg") || ct.includes("jpg")) ext = ".jpg";
      const fname = `WETH_${MINT.slice(0, 8)}${ext}`;
      fs.writeFileSync(path.join(outDir, fname), buf);
      iconLocal = `/token-catalog/${fname}`;
    }
  }

  const row = {
    category: "Blockchain",
    query: "WETH",
    mint: MINT,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    isVerified: token.isVerified ?? null,
    organicScore: token.organicScore ?? null,
    iconUrl,
    iconLocal,
    source: "Jupiter tokens/v2/search by mint (canonical WETH)",
  };

  console.log(JSON.stringify(row, null, 2));

  const draftPath = path.join(__dirname, "..", "src", "config", "token-catalog.json");
  if (fs.existsSync(draftPath)) {
    const arr = JSON.parse(fs.readFileSync(draftPath, "utf8"));
    const idx = arr.findIndex(
      (r) => r.category === "Blockchain" && r.query === "WETH"
    );
    if (idx >= 0) {
      arr[idx] = row;
      fs.writeFileSync(draftPath, JSON.stringify(arr, null, 2), "utf8");
      console.error("Updated token-catalog-draft.json");
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
