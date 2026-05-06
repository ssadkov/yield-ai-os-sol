import { PublicKey } from "@solana/web3.js";
import { RPC_URL, SOL_MINT, USDC_MINT_STR } from "@/lib/constants";

const RATE_BPS_DECIMALS = 100;

export interface JupiterProtocolPool {
  asset: string;
  provider: "Jupiter";
  totalAPY: number;
  depositApy: number;
  borrowAPY: number;
  token: string;
  tokenDecimals: number;
  protocol: "Jupiter";
  tvlUSD?: number;
  dailyVolumeUSD: number;
  poolType: "Lending" | "Vault";
  marketAddress?: string;
  utilization?: number;
  totalSupply?: number;
  totalBorrow?: number;
  originalPool: Record<string, string | number | boolean | null>;
}

interface FetchJupiterLendMarketsOptions {
  focusOnly?: boolean;
  maxVaults?: number;
  vaultIds?: number[];
  concurrency?: number;
  signal?: AbortSignal;
}

const TOKEN_META: Record<string, { symbol: string; decimals: number; logoUrl?: string }> = {
  [SOL_MINT]: { symbol: "SOL", decimals: 9, logoUrl: "/token_ico/sol.png" },
  [USDC_MINT_STR]: { symbol: "USDC", decimals: 6, logoUrl: "/token_ico/usdc.png" },
  JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD: { symbol: "JupUSD", decimals: 6, logoUrl: "/token_ico/jupusd.png" },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", decimals: 6, logoUrl: "/token_ico/usdt.png" },
  "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": { symbol: "USDG", decimals: 6, logoUrl: "/token_ico/usdg.png" },
  USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA: { symbol: "USDS", decimals: 6, logoUrl: "/token_ico/usds.png" },
  HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr: { symbol: "EURC", decimals: 6, logoUrl: "/token_ico/eurc.png" },
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: { symbol: "JitoSOL", decimals: 9 },
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: { symbol: "mSOL", decimals: 9 },
  jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v: { symbol: "JupSOL", decimals: 9 },
  bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: { symbol: "bSOL", decimals: 9 },
  cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij: { symbol: "cbBTC", decimals: 8 },
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": { symbol: "WBTC", decimals: 8 },
  CtzPWv73Sn1dMGVU3ZtLv9yWSyUAanBni19YWDaznnkn: { symbol: "xBTC", decimals: 8 },
  LBTCgU4b3wsFKsPwBn1rRZDx5DoFutM6RPiEt1TPDsY: { symbol: "LBTC", decimals: 8 },
  zBTCug3er3tLyffELcvDNrKkCymbPWysGcWihESYfLg: { symbol: "ZBTC", decimals: 8 },
  "3orqhCKM5admbcHkHQhRAEKbXhUT5VPgsQqz7fBa6QdF": { symbol: "fBTC", decimals: 8 },
  XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W: { symbol: "SPYx", decimals: 8 },
  Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ: { symbol: "QQQx", decimals: 8 },
  Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh: { symbol: "NVDAx", decimals: 8 },
  XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB: { symbol: "TSLAx", decimals: 8 },
  XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp: { symbol: "AAPLx", decimals: 8 },
  XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN: { symbol: "GOOGLx", decimals: 8 },
  XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ: { symbol: "MSTRx", decimals: 8 },
  "5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5": { symbol: "ONyc", decimals: 9 },
};

const FOCUS_MINTS = new Set([
  SOL_MINT,
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v",
  "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
  "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
  "CtzPWv73Sn1dMGVU3ZtLv9yWSyUAanBni19YWDaznnkn",
  "LBTCgU4b3wsFKsPwBn1rRZDx5DoFutM6RPiEt1TPDsY",
  "zBTCug3er3tLyffELcvDNrKkCymbPWysGcWihESYfLg",
  "3orqhCKM5admbcHkHQhRAEKbXhUT5VPgsQqz7fBa6QdF",
  "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
  "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ",
  "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
  "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
  "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
  "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN",
  "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ",
  "5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5",
]);

export const JUPITER_EARN_IDEA_VAULT_IDS = [
  1, // SOL / USDC
  9, // xBTC / USDC
  11, // cbBTC / USDC
  13, // JupSOL / USDC
  15, // JitoSOL / USDC
  77, // TSLAx / USDC
  78, // SPYx / USDC
  79, // QQQx / USDC
  80, // NVDAx / USDC
  81, // TSLAx / JupUSD
  82, // SPYx / JupUSD
  83, // QQQx / JupUSD
  84, // NVDAx / JupUSD
];

async function loadJupiterLendRead(): Promise<typeof import("@jup-ag/lend-read")> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<typeof import("@jup-ag/lend-read")>;
  return dynamicImport("@jup-ag/lend-read");
}

function rateToPercent(value: unknown): number {
  if (!value || typeof (value as { toString?: unknown }).toString !== "function") return 0;
  return Number((value as { toString: () => string }).toString()) / RATE_BPS_DECIMALS;
}

function rewardRateToPercent(value: unknown): number {
  if (!value || typeof (value as { toString?: unknown }).toString !== "function") return 0;
  return Number((value as { toString: () => string }).toString()) / 1_000_000_000_000;
}

function riskConfigToPercent(value: unknown): number {
  if (!value || typeof (value as { toString?: unknown }).toString !== "function") return 0;
  return Number((value as { toString: () => string }).toString()) / 10;
}

function bnToUiAmount(value: unknown, decimals: number): number | undefined {
  if (!value || typeof (value as { toString?: unknown }).toString !== "function") return undefined;
  const raw = Number((value as { toString: () => string }).toString());
  if (!Number.isFinite(raw)) return undefined;
  return raw / 10 ** decimals;
}

function mintToString(value: PublicKey | { toBase58: () => string }): string {
  return value.toBase58();
}

function metaForMint(mint: string): { symbol: string; decimals: number; logoUrl?: string } {
  return TOKEN_META[mint] ?? { symbol: `${mint.slice(0, 4)}...${mint.slice(-4)}`, decimals: 6 };
}

async function mapConcurrent<T, U>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<U | null>,
): Promise<U[]> {
  const out: U[] = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      const result = await fn(item);
      if (result) out.push(result);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function fetchJupiterLendMarkets(options: FetchJupiterLendMarketsOptions = {}) {
  const { Client } = await loadJupiterLendRead();
  const client = new Client(RPC_URL, { commitment: "confirmed" });
  const totalVaults = await client.vault.getTotalVaults();
  const maxVaults = Math.min(options.maxVaults ?? totalVaults, totalVaults);
  const ids = options.vaultIds?.length
    ? options.vaultIds.filter((vaultId) => vaultId > 0 && vaultId <= totalVaults)
    : Array.from({ length: maxVaults }, (_, idx) => idx + 1);
  const failedVaultIds: number[] = [];

  const borrowVaults = await mapConcurrent(ids, options.concurrency ?? 6, async (vaultId) => {
    try {
      if (options.signal?.aborted) return null;
      const vault = await client.vault.getVaultByVaultId(vaultId);
      const supplyMint = mintToString(vault.constantViews.supplyToken);
      const borrowMint = mintToString(vault.constantViews.borrowToken);
      if (options.focusOnly && !FOCUS_MINTS.has(supplyMint) && !FOCUS_MINTS.has(borrowMint)) return null;

      const supply = metaForMint(supplyMint);
      const borrow = metaForMint(borrowMint);
      const depositApy = rateToPercent(vault.exchangePricesAndRates.supplyRateVault);
      const borrowAPY = rateToPercent(vault.exchangePricesAndRates.borrowRateVault);

      return {
        asset: `${supply.symbol} / ${borrow.symbol}`,
        provider: "Jupiter" as const,
        totalAPY: depositApy,
        depositApy,
        borrowAPY,
        token: supplyMint,
        tokenDecimals: supply.decimals,
        protocol: "Jupiter" as const,
        dailyVolumeUSD: 0,
        poolType: "Lending" as const,
        marketAddress: mintToString(vault.vault),
        originalPool: {
          kind: "jupiter_borrow_vault",
          vaultId,
          vault: mintToString(vault.vault),
          supplyToken: supplyMint,
          supplySymbol: supply.symbol,
          borrowToken: borrowMint,
          borrowSymbol: borrow.symbol,
          collateralFactor: riskConfigToPercent(vault.configs.collateralFactor),
          liquidationThreshold: riskConfigToPercent(vault.configs.liquidationThreshold),
          borrowFee: Number(vault.configs.borrowFee.toString()) / RATE_BPS_DECIMALS,
          supplyRateVault: depositApy,
          borrowRateVault: borrowAPY,
          rewardsOrFeeRateSupply: rateToPercent(vault.exchangePricesAndRates.rewardsOrFeeRateSupply),
          rewardsOrFeeRateBorrow: rateToPercent(vault.exchangePricesAndRates.rewardsOrFeeRateBorrow),
          minimumBorrowingRaw: vault.limitsAndAvailability.minimumBorrowing.toString(),
          borrowableRaw: vault.limitsAndAvailability.borrowable.toString(),
          totalSupplyVaultRaw: vault.totalSupplyAndBorrow.totalSupplyVault.toString(),
          totalBorrowVaultRaw: vault.totalSupplyAndBorrow.totalBorrowVault.toString(),
        },
      } satisfies JupiterProtocolPool;
    } catch {
      failedVaultIds.push(vaultId);
      return null;
    }
  });

  const earnMarkets = (await client.lending.getAllJlTokenDetails())
    .map((market): JupiterProtocolPool | null => {
      const token = mintToString(market.underlyingAddress);
      if (options.focusOnly && !FOCUS_MINTS.has(token) && token !== USDC_MINT_STR) return null;
      const meta = metaForMint(token);
      const supplyRate = rateToPercent(market.supplyRate);
      const rewardsRate = rewardRateToPercent(market.rewardsRate);
      const totalAPY = supplyRate + rewardsRate;
      const totalSupply = bnToUiAmount(market.totalAssets, meta.decimals);
      if (totalAPY <= 0 && (!totalSupply || totalSupply <= 0)) return null;

      return {
        asset: `${meta.symbol} Earn`,
        provider: "Jupiter" as const,
        totalAPY,
        depositApy: totalAPY,
        borrowAPY: 0,
        token,
        tokenDecimals: meta.decimals,
        protocol: "Jupiter" as const,
        dailyVolumeUSD: 0,
        poolType: "Vault" as const,
        totalSupply,
        originalPool: {
          kind: "jupiter_earn_market",
          jlTokenMint: mintToString(market.tokenAddress),
          name: market.name,
          symbol: market.symbol,
          underlyingToken: token,
          underlyingSymbol: meta.symbol,
          supplyRate,
          rewardsRate,
          conversionRateToAssets: market.conversionRateToAssets.toString(),
          conversionRateToShares: market.conversionRateToShares.toString(),
        },
      } satisfies JupiterProtocolPool;
    })
    .filter((pool): pool is JupiterProtocolPool => pool !== null);

  const data = [...earnMarkets, ...borrowVaults].sort((a, b) => {
    const aSpread = a.borrowAPY > 0 ? a.borrowAPY * -1 : a.depositApy;
    const bSpread = b.borrowAPY > 0 ? b.borrowAPY * -1 : b.depositApy;
    return bSpread - aSpread;
  });

  return {
    success: true,
    meta: {
      fetchedAtMs: Date.now(),
      sdk: "@jup-ag/lend-read",
      totalVaults,
      scannedVaultIds: ids.length,
      failedVaultIds,
      focusOnly: Boolean(options.focusOnly),
    },
    data,
    count: data.length,
  };
}
