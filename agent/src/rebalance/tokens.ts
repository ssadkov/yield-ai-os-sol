export type StrategyName = "Conservative" | "Balanced" | "Growth";

export interface TokenDef {
  symbol: string;
  mint: string;
  decimals: number;
  /** Token-2022 tokens need special ATA derivation */
  isToken2022?: boolean;
}

export interface Allocation {
  token: TokenDef;
  /** Target weight 0..1 */
  weight: number;
}

export const USDC: TokenDef = {
  symbol: "USDC",
  mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  decimals: 6,
};

export const USDY: TokenDef = {
  symbol: "USDY",
  mint: "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6",
  decimals: 6,
};

export const CBBTC: TokenDef = {
  symbol: "cbBTC",
  mint: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
  decimals: 8,
};

export const SPYX: TokenDef = {
  symbol: "SPYx",
  mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
  decimals: 8,
  isToken2022: true,
};

export const STRATEGY_ALLOCATIONS: Record<StrategyName, Allocation[]> = {
  Conservative: [
    { token: USDC, weight: 0.6 },
    { token: USDY, weight: 0.4 },
  ],
  Balanced: [
    { token: USDC, weight: 0.3 },
    { token: USDY, weight: 0.3 },
    { token: CBBTC, weight: 0.2 },
    { token: SPYX, weight: 0.2 },
  ],
  Growth: [
    { token: USDC, weight: 0.1 },
    { token: USDY, weight: 0.2 },
    { token: CBBTC, weight: 0.35 },
    { token: SPYX, weight: 0.35 },
  ],
};

/** All unique mints across every strategy (for price fetching) */
export function allStrategyMints(): TokenDef[] {
  const seen = new Set<string>();
  const result: TokenDef[] = [];
  for (const allocs of Object.values(STRATEGY_ALLOCATIONS)) {
    for (const a of allocs) {
      if (!seen.has(a.token.mint)) {
        seen.add(a.token.mint);
        result.push(a.token);
      }
    }
  }
  return result;
}
