import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  type AccountInfo,
  type ParsedAccountData,
} from "@solana/web3.js";
import { fetchPrices, fetchTokenMetadata, getTokenIcon } from "@/lib/jupiter";
import { SOL_MINT, USDC_MINT_STR } from "@/lib/constants";

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);

const SOL_LOGO =
  "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png";

function fallbackUsdPrice(mint: string): number | null {
  // Keep stablecoin valuation resilient when external price APIs are unavailable.
  // This prevents "totalUsd = 0" for obvious USD-pegged balances like USDC.
  if (mint === USDC_MINT_STR) return 1;
  return null;
}

export interface AssetRow {
  mint: string;
  symbol: string;
  name: string;
  logoURI?: string;
  balance: number;
  rawAmount: string;
  decimals: number;
  usdPrice: number | null;
  usdValue: number | null;
  priceChange24h?: number | null;
  apr?: {
    value: number;
    source: string;
  };
}

export interface FetchOptions {
  includeSol?: boolean;
}

export async function fetchPortfolioAssets(
  connection: Connection,
  owner: PublicKey,
  opts: FetchOptions = {}
): Promise<{ assets: AssetRow[]; totalUsd: number }> {
  const { includeSol = true } = opts;

  const [solBalance, splAccounts, token2022Accounts] = await Promise.all([
    includeSol ? connection.getBalance(owner) : Promise.resolve(0),
    connection.getParsedTokenAccountsByOwner(owner, {
      programId: TOKEN_PROGRAM_ID,
    }),
    connection.getParsedTokenAccountsByOwner(owner, {
      programId: TOKEN_2022_PROGRAM_ID,
    }),
  ]);

  interface RawToken {
    mint: string;
    rawAmount: string;
    decimals: number;
  }
  const rawTokens: RawToken[] = [];
  const splMints: string[] = [];

  const allAccounts = [...splAccounts.value, ...token2022Accounts.value];
  for (const { account } of allAccounts) {
    const parsed = (account as AccountInfo<ParsedAccountData>).data.parsed;
    const info = parsed?.info;
    if (!info) continue;
    const rawAmount = String(info.tokenAmount?.amount ?? "0");
    if (BigInt(rawAmount) === BigInt(0)) continue;
    const decimals: number = info.tokenAmount?.decimals ?? 0;
    const mint: string = info.mint;
    rawTokens.push({ mint, rawAmount, decimals });
    splMints.push(mint);
  }

  const priceMints = includeSol ? [SOL_MINT, ...splMints] : splMints;
  const [prices, tokenMeta] = await Promise.all([
    fetchPrices(priceMints),
    fetchTokenMetadata(splMints),
  ]);

  const rows: AssetRow[] = [];

  if (includeSol) {
    const solPriceData = prices[SOL_MINT];
    const solPrice = solPriceData?.usdPrice ?? fallbackUsdPrice(SOL_MINT);
    const solBal = solBalance / LAMPORTS_PER_SOL;
    rows.push({
      mint: SOL_MINT,
      symbol: "SOL",
      name: "Solana",
      logoURI: SOL_LOGO,
      balance: solBal,
      rawAmount: String(solBalance),
      decimals: 9,
      usdPrice: solPrice,
      usdValue: solPrice !== null ? solBal * solPrice : null,
      priceChange24h: solPriceData?.priceChange24h ?? null,
    });
  }

  for (const { mint, rawAmount, decimals } of rawTokens) {
    const meta = tokenMeta[mint];
    const balance = Number(rawAmount) / 10 ** decimals;
    const priceData = prices[mint];
    const price = priceData?.usdPrice ?? fallbackUsdPrice(mint);

    const fallbackSymbol =
      mint === USDC_MINT_STR ? "USDC" : mint.slice(0, 4) + "...";
    const fallbackName = mint === USDC_MINT_STR ? "USD Coin" : "Unknown Token";

    rows.push({
      mint,
      symbol: meta?.symbol ?? fallbackSymbol,
      name: meta?.name ?? fallbackName,
      logoURI: getTokenIcon(meta),
      balance,
      rawAmount,
      decimals,
      usdPrice: price,
      usdValue: price !== null ? balance * price : null,
      priceChange24h: priceData?.priceChange24h ?? null,
    });
  }

  let total = 0;
  for (const row of rows) {
    if (row.usdValue !== null) total += row.usdValue;
  }

  rows.sort((a, b) => {
    if (a.mint === USDC_MINT_STR) return -1;
    if (b.mint === USDC_MINT_STR) return 1;
    return (b.usdValue ?? 0) - (a.usdValue ?? 0);
  });

  return { assets: rows, totalUsd: total };
}
