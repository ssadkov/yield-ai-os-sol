import { NextResponse } from "next/server";
import { EARN_IDEAS, EARN_IDEA_SYMBOLS, type EarnIdea } from "@/lib/earnIdeas";
import { SOL_MINT, USDC_MINT_STR } from "@/lib/constants";
import {
  fetchJupiterLendMarkets,
  JUPITER_EARN_IDEA_VAULT_IDS,
} from "@/server/agent/protocols/jupiterLendMarkets";

export const runtime = "nodejs";
export const revalidate = 300;

const ENDPOINTS = {
  jupiterPools: "https://yieldai.app/api/protocols/jupiter/pools",
  kaminoPools: "https://yieldai.app/api/protocols/kamino/pools",
  kaminoBorrowLend: "https://yieldai.app/api/protocols/kamino/borrowLend",
} as const;

interface ProtocolPool {
  asset: string;
  provider: string;
  totalAPY?: number;
  depositApy?: number;
  borrowAPY?: number;
  token: string;
  tokenDecimals?: number;
  protocol: string;
  tvlUSD?: number;
  poolType?: string;
  marketAddress?: string;
  originalPool?: Record<string, unknown> & {
    vaultAddress?: string;
    vaultName?: string;
    tokenMint?: string;
    tokenSymbol?: string;
    marketName?: string;
    lendingMarket?: string;
    liquidityToken?: string;
    liquidityTokenMint?: string;
    maxLtv?: string;
  };
}

interface ProtocolResponse {
  success?: boolean;
  data?: ProtocolPool[];
  count?: number;
  meta?: unknown;
}

const GROUPS = [
  {
    id: "xstocks-usdc-loop",
    title: "xStocks collateral loop",
    focus: "xStocks" as const,
    mints: [
      "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
      "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ",
      "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
      "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
      "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
      "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN",
      "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ",
    ],
    note: "Direct Token-2022 deposit/withdraw still needs token-interface support.",
  },
  {
    id: "btc-usdc-loop",
    title: "BTC collateral loop",
    focus: "BTC" as const,
    mints: [
      "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
      "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
      "CtzPWv73Sn1dMGVU3ZtLv9yWSyUAanBni19YWDaznnkn",
      "LBTCgU4b3wsFKsPwBn1rRZDx5DoFutM6RPiEt1TPDsY",
      "zBTCug3er3tLyffELcvDNrKkCymbPWysGcWihESYfLg",
      "3orqhCKM5admbcHkHQhRAEKbXhUT5VPgsQqz7fBa6QdF",
    ],
    note: "cbBTC is the first target because it is already in the strategy token set.",
  },
  {
    id: "sol-usdc-loop",
    title: "SOL collateral loop",
    focus: "SOL" as const,
    mints: [
      SOL_MINT,
      "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
      "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
      "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v",
      "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
    ],
    note: "Keep a conservative borrow buffer; SOL collateral volatility dominates this loop.",
  },
  {
    id: "onre-rwa-loop",
    title: "OnRe RWA loop",
    focus: "RWA" as const,
    mints: ["5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5"],
    note: "Interesting RWA risk source, but spread is thinner than BTC/xStocks/SOL loops.",
  },
];

function apy(pool: ProtocolPool): number {
  return Number(pool.depositApy ?? pool.totalAPY ?? 0);
}

function maxLtv(pool: ProtocolPool): number {
  return Number(pool.originalPool?.maxLtv ?? pool.originalPool?.collateralFactor ?? 0);
}

function marketKey(pool: ProtocolPool): string | null {
  return pool.marketAddress ?? pool.originalPool?.lendingMarket ?? null;
}

function formatPct(value: number): string {
  return `${value.toFixed(2)}%`;
}

async function fetchProtocol(url: string): Promise<ProtocolResponse> {
  const res = await fetch(url, { next: { revalidate } });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return (await res.json()) as ProtocolResponse;
}

export async function GET() {
  try {
    const [jupiterPools, kaminoPools, kaminoBorrowLend, jupiterBorrowLend] = await Promise.all([
      fetchProtocol(ENDPOINTS.jupiterPools),
      fetchProtocol(ENDPOINTS.kaminoPools),
      fetchProtocol(ENDPOINTS.kaminoBorrowLend),
      fetchJupiterLendMarkets({
        focusOnly: true,
        vaultIds: JUPITER_EARN_IDEA_VAULT_IDS,
      }).catch((err: unknown) => ({
        success: false,
        data: [] as ProtocolPool[],
        count: 0,
        meta: { error: err instanceof Error ? err.message : String(err) },
      })),
    ]);

    const earnPools = [
      ...(jupiterPools.data ?? []),
      ...(kaminoPools.data ?? []),
    ].filter((pool) => apy(pool) > 0);

    const bestUsdcEarn = earnPools
      .filter((pool) => pool.token === USDC_MINT_STR)
      .sort((a, b) => apy(b) - apy(a))[0];

    const bestUsdcApy = bestUsdcEarn ? apy(bestUsdcEarn) : 0;
    const borrowLend: ProtocolPool[] = [
      ...(kaminoBorrowLend.data ?? []),
      ...((jupiterBorrowLend.data ?? []) as ProtocolPool[]),
    ];
    const byMarket = new Map<string, ProtocolPool[]>();
    for (const pool of borrowLend) {
      const key = marketKey(pool);
      if (!key) continue;
      const list = byMarket.get(key) ?? [];
      list.push(pool);
      byMarket.set(key, list);
    }

    const ideas: EarnIdea[] = [];
    if (bestUsdcEarn) {
      ideas.push({
        id: "usdc-kamino-neutral",
        title: "Best USDC earn",
        protocol: bestUsdcEarn.provider,
        focus: "USDC",
        description: `Deposit USDC into ${bestUsdcEarn.asset}.`,
        apyLabel: `${formatPct(bestUsdcApy)} APY`,
        requiredMints: [USDC_MINT_STR],
        note: `Live from ${bestUsdcEarn.protocol} pools. TVL: $${Math.round(bestUsdcEarn.tvlUSD ?? 0).toLocaleString("en-US")}.`,
        action: bestUsdcEarn.protocol === "Kamino" && bestUsdcEarn.originalPool?.vaultAddress
          ? {
              type: "kaminoKvaultDeposit",
              kvault: bestUsdcEarn.originalPool.vaultAddress,
              tokenMint: bestUsdcEarn.token,
              tokenDecimals: bestUsdcEarn.tokenDecimals ?? 6,
            }
          : undefined,
      });
    }

    for (const group of GROUPS) {
      const groupSet = new Set(group.mints);
      const candidates = borrowLend
        .filter((pool) => groupSet.has(pool.token) && maxLtv(pool) > 0)
        .map((collateral) => {
          const market = marketKey(collateral);
          const isJupiterBorrowVault =
            collateral.protocol === "Jupiter" &&
            collateral.originalPool?.kind === "jupiter_borrow_vault";
          const borrowToken = isJupiterBorrowVault
            ? String(collateral.originalPool?.borrowToken ?? "")
            : "";
          const usdcReserve = market
            ? byMarket.get(market)?.find((pool) => pool.token === USDC_MINT_STR)
            : null;
          const borrowApy = borrowToken === USDC_MINT_STR
            ? Number(collateral.borrowAPY ?? 0)
            : Number(usdcReserve?.borrowAPY ?? 0);
          return {
            collateral,
            market,
            marketName: isJupiterBorrowVault
              ? `${String(collateral.originalPool?.supplySymbol ?? collateral.asset)} / ${String(collateral.originalPool?.borrowSymbol ?? "debt")}`
              : collateral.originalPool?.marketName ?? collateral.marketAddress ?? "Market",
            borrowApy,
            spread: bestUsdcApy - borrowApy,
          };
        })
        .filter((candidate) => candidate.borrowApy > 0)
        .sort((a, b) => {
          const spreadDiff = b.spread - a.spread;
          if (Math.abs(spreadDiff) > 0.001) return spreadDiff;
          return group.mints.indexOf(a.collateral.token) - group.mints.indexOf(b.collateral.token);
        });

      const best = candidates[0];
      if (!best) {
        const fallback = EARN_IDEAS.find((idea) => idea.id === group.id);
        if (fallback) ideas.push(fallback);
        continue;
      }

      const collateralSymbols = [...new Set(
        candidates
          .filter((candidate) => candidate.market === best.market)
          .map((candidate) => EARN_IDEA_SYMBOLS[candidate.collateral.token] ?? candidate.collateral.originalPool?.liquidityToken ?? candidate.collateral.asset.split(" ")[0])
      )];

      ideas.push({
        id: group.id,
        title: group.title,
        protocol: best.collateral.provider,
        focus: group.focus,
        description: `Use ${collateralSymbols.slice(0, 4).join(", ")}${collateralSymbols.length > 4 ? "..." : ""} collateral in ${best.marketName}, borrow USDC, then route USDC to ${bestUsdcEarn?.asset ?? "best USDC earn"}.`,
        apyLabel: `${formatPct(bestUsdcApy)} earn`,
        borrowLabel: `${formatPct(best.borrowApy)} USDC borrow`,
        spreadLabel: `${best.spread >= 0 ? "+" : ""}${formatPct(best.spread)} gross spread`,
        requiredMints: group.mints,
        note: group.note,
      });
    }

    return NextResponse.json({
      success: true,
      fetchedAtMs: Date.now(),
      source: {
        ...ENDPOINTS,
        jupiterBorrowLend: "@jup-ag/lend-read",
      },
      ideas,
      fallback: false,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({
      success: false,
      error: message,
      ideas: EARN_IDEAS,
      fallback: true,
    });
  }
}
