import type { AssetRow } from "@/lib/portfolioAssets";

/**
 * Protocol-issued position receipts (Jupiter Lend NFTs like `jv78`, Kamino
 * share tokens, etc.) are SPL balances on the vault PDA but must not appear
 * in the generic withdraw / convert-all UI — users cannot meaningfully
 * transfer them like normal fungible tokens.
 */
export function isProtocolPositionOrShareToken(
  asset: Pick<AssetRow, "mint" | "symbol" | "name">,
  opts?: { kaminoShareMints?: ReadonlySet<string> },
): boolean {
  if (opts?.kaminoShareMints?.has(asset.mint)) return true;
  const sym = asset.symbol.trim();
  const name = asset.name.toLowerCase();
  if (name.startsWith("jupiter vault")) return true;
  if (name.startsWith("kamino ")) return true;
  if (/^jv\d+$/i.test(sym)) return true;
  if (sym.toLowerCase().startsWith("ki")) return true;
  return false;
}
