import tokenCatalogJson from "@/config/token-catalog.json";
import { ALL_TOKENS } from "@/server/agent/rebalance/tokens";

export type TradeableCategory =
  | "Blockchain"
  | "Solana ecosystem"
  | "xStocks"
  | "Gold";

export interface TradeableTokenEntry {
  category: string;
  query: string;
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  isVerified?: boolean | null;
  organicScore?: number | null;
  iconUrl?: string;
  iconLocal?: string | null;
  source?: string;
}

export const TRADEABLE_TOKEN_CATALOG: TradeableTokenEntry[] =
  tokenCatalogJson as TradeableTokenEntry[];

/** Shown when discussing xStocks in chat. */
export const XSTOCKS_DIVIDEND_NOTE =
  "Tokenized equities (xStocks) may pay dividends or undergo corporate actions depending on the issuer; details follow the specific product and are not guaranteed in-app.";

const bySymbolQueryOrMint = new Map<string, TradeableTokenEntry>();
for (const e of TRADEABLE_TOKEN_CATALOG) {
  bySymbolQueryOrMint.set(e.symbol.toUpperCase(), e);
  bySymbolQueryOrMint.set(e.query.toUpperCase(), e);
  bySymbolQueryOrMint.set(e.mint, e);
}

const WSOL_MINT = "So11111111111111111111111111111111111111112";

const INPUT_ALIASES: Record<string, string> = {
  BTC: "cbBTC",
  BITCOIN: "cbBTC",
  БИТКОИН: "cbBTC",
  БИТОК: "cbBTC",
  SOLANA: "SOL",
  СОЛАНА: "SOL",
  СОЛ: "SOL",
  ETHEREUM: "ETH",
  ETHER: "ETH",
  WETH: "ETH",
  ЗОЛОТО: "XAUt0",
  GOLD: "XAUt0",
  ONYC: "ONe",
  ONY: "ONe",
  ONE: "ONe",
};

function normalizeUserSymbol(raw: string): string {
  const s = raw.toUpperCase().trim();
  return INPUT_ALIASES[s] ?? s;
}

/**
 * Resolve a tradeable catalog token by user-facing symbol/query (not strategy-only).
 */
export function resolveTradeableToken(
  userSymbol: string,
): TradeableTokenEntry | null {
  const key = normalizeUserSymbol(userSymbol);
  return bySymbolQueryOrMint.get(key) ?? null;
}

/**
 * Resolve mint for charts / prices: strategy tokens first, then tradeable catalog.
 */
export function resolveTokenMintForChart(
  userSymbol: string,
): { mint: string; symbol: string } | null {
  const symLower = userSymbol.toLowerCase();
  const fromStrategy = ALL_TOKENS.find(
    (t) =>
      t.symbol.toLowerCase() === symLower ||
      (t.symbol.toLowerCase() === "cbbtc" &&
        (symLower === "btc" || symLower === "bitcoin")) ||
      (t.symbol.toLowerCase() === "oney" &&
        (symLower === "one" || symLower === "onyc" || symLower === "ony")),
  );
  if (fromStrategy) {
    return { mint: fromStrategy.mint, symbol: fromStrategy.symbol };
  }
  if (symLower === "btc" || symLower === "bitcoin") {
    const cb = ALL_TOKENS.find((t) => t.symbol === "cbBTC");
    if (cb) return { mint: cb.mint, symbol: "cbBTC" };
  }
  if (userSymbol.toUpperCase() === "SOL") {
    return {
      mint: WSOL_MINT,
      symbol: "SOL",
    };
  }
  const cat = resolveTradeableToken(userSymbol);
  if (cat) return { mint: cat.mint, symbol: cat.symbol };
  return null;
}

/**
 * Token for vault swap proposal: strategy list first, then tradeable catalog.
 */
export function resolveTokenForSwap(userSymbol: string): {
  symbol: string;
  mint: string;
  decimals: number;
} | null {
  const lookupSym = normalizeUserSymbol(userSymbol);

  const strategy = ALL_TOKENS.find(
    (t) => t.symbol.toUpperCase() === lookupSym,
  );
  if (strategy) {
    return {
      symbol: strategy.symbol,
      mint: strategy.mint,
      decimals: strategy.decimals,
    };
  }

  const trade = resolveTradeableToken(lookupSym);
  if (trade) {
    return {
      symbol: trade.symbol,
      mint: trade.mint,
      decimals: trade.decimals,
    };
  }

  if (lookupSym === "SOL") {
    return {
      symbol: "SOL",
      mint: WSOL_MINT,
      decimals: 9,
    };
  }

  return null;
}

export function listTradeableByCategory(
  category?: TradeableCategory | string,
): TradeableTokenEntry[] {
  if (!category) return [...TRADEABLE_TOKEN_CATALOG];
  return TRADEABLE_TOKEN_CATALOG.filter((e) => e.category === category);
}

export function searchTradeableCatalog(query: string): TradeableTokenEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...TRADEABLE_TOKEN_CATALOG];
  return TRADEABLE_TOKEN_CATALOG.filter(
    (e) =>
      e.symbol.toLowerCase().includes(q) ||
      e.name.toLowerCase().includes(q) ||
      e.query.toLowerCase().includes(q) ||
      e.mint.toLowerCase().includes(q),
  );
}

/** Resolve a user symbol to mint for price APIs (catalog + strategy tokens + SOL). */
export function resolveMintForPriceQuery(symbol: string): string | null {
  const tr = resolveTradeableToken(symbol);
  if (tr) return tr.mint;
  const key = normalizeUserSymbol(symbol);
  const st = ALL_TOKENS.find((t) => t.symbol.toUpperCase() === key);
  if (st) return st.mint;
  if (key === "SOL") return WSOL_MINT;
  return null;
}

export function compactCatalogForPrompt(maxPerCategory = 40): string {
  const byCat = new Map<string, TradeableTokenEntry[]>();
  for (const e of TRADEABLE_TOKEN_CATALOG) {
    const list = byCat.get(e.category) ?? [];
    if (list.length < maxPerCategory) list.push(e);
    byCat.set(e.category, list);
  }
  const o: Record<string, Array<{ symbol: string; name: string; mint: string }>> =
    {};
  for (const [k, v] of byCat) {
    o[k] = v.map((t) => ({
      symbol: t.symbol,
      name: t.name,
      mint: t.mint,
    }));
  }
  return JSON.stringify(o, null, 2);
}
