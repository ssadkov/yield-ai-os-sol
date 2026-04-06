import type { StrategyName } from "@/lib/vault";

export type StrategyDef = {
  name: StrategyName;
  risk: "low" | "medium" | "high";
  summary: string;
  targetMix: Array<{ symbol: string; weightPct: number }>;
};

export const STRATEGY_DEFS: Record<StrategyName, StrategyDef> = {
  Conservative: {
    name: "Conservative",
    risk: "low",
    summary: "Lower risk. Prioritizes stability and yield over volatility.",
    targetMix: [
      { symbol: "USDC", weightPct: 40 },
      { symbol: "USDY", weightPct: 60 },
    ],
  },
  Balanced: {
    name: "Balanced",
    risk: "medium",
    summary: "Medium risk. Mix of stable yield plus diversified growth exposure.",
    targetMix: [
      { symbol: "USDC", weightPct: 20 },
      { symbol: "USDY", weightPct: 30 },
      { symbol: "cbBTC", weightPct: 20 },
      { symbol: "SPYx", weightPct: 20 },
      { symbol: "XAUt0", weightPct: 10 },
    ],
  },
  Aggressive: {
    name: "Aggressive",
    risk: "high",
    summary: "Higher risk. Maximizes growth exposure; can be more volatile.",
    targetMix: [
      { symbol: "USDY", weightPct: 15 },
      { symbol: "ONe", weightPct: 15 },
      { symbol: "cbBTC", weightPct: 20 },
      { symbol: "SPYx", weightPct: 20 },
      { symbol: "JitoSOL", weightPct: 20 },
    ],
  },
};

export function formatTargetMix(def: StrategyDef): string {
  return def.targetMix.map((t) => `${t.weightPct}% ${t.symbol}`).join(" / ");
}

