export type StrategyName = "Conservative" | "Balanced" | "Growth";

export interface TokenDef {
  symbol: string;
  mint: string;
  decimals: number;
  isToken2022?: boolean;
}

export interface Allocation {
  token: TokenDef;
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

export const XAUT0: TokenDef = {
  symbol: "XAUt0",
  mint: "AymATz4TCL9sWNEEV9Kvyz45CHVhDZ6kUgjTJPzLpU9P",
  decimals: 6,
};

export const ONYC: TokenDef = {
  symbol: "ONe",
  mint: "5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5",
  decimals: 9,
};

export const JITOSOL: TokenDef = {
  symbol: "JitoSOL",
  mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  decimals: 9,
};

export const STRATEGY_ALLOCATIONS: Record<StrategyName, Allocation[]> = {
  Conservative: [
    { token: USDC, weight: 0.4 },
    { token: USDY, weight: 0.6 },
  ],
  Balanced: [
    { token: USDC, weight: 0.2 },
    { token: USDY, weight: 0.3 },
    { token: CBBTC, weight: 0.2 },
    { token: SPYX, weight: 0.2 },
    { token: XAUT0, weight: 0.1 },
  ],
  Growth: [
    { token: USDY, weight: 0.15 },
    { token: ONYC, weight: 0.15 },
    { token: CBBTC, weight: 0.2 },
    { token: SPYX, weight: 0.2 },
    { token: JITOSOL, weight: 0.2 },
  ],
};

