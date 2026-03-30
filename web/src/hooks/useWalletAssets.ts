"use client";

import { useEffect, useState, useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL, PublicKey, type AccountInfo, type ParsedAccountData } from "@solana/web3.js";
import { fetchPrices, fetchTokenMetadata, getTokenIcon } from "@/lib/jupiter";
import { SOL_MINT, USDC_MINT_STR } from "@/lib/constants";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const SOL_LOGO = "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png";

export interface AssetRow {
  mint: string;
  symbol: string;
  name: string;
  logoURI?: string;
  balance: number;
  decimals: number;
  usdPrice: number | null;
  usdValue: number | null;
}

export function useWalletAssets() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [totalUsd, setTotalUsd] = useState<number>(0);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!publicKey) {
      setAssets([]);
      setTotalUsd(0);
      return;
    }

    setLoading(true);
    try {
      const [solBalance, tokenAccounts] = await Promise.all([
        connection.getBalance(publicKey),
        connection.getParsedTokenAccountsByOwner(publicKey, {
          programId: TOKEN_PROGRAM_ID,
        }),
      ]);

      interface RawToken {
        mint: string;
        rawAmount: number;
        decimals: number;
      }
      const rawTokens: RawToken[] = [];
      const splMints: string[] = [];

      for (const { account } of tokenAccounts.value) {
        const parsed = (account as AccountInfo<ParsedAccountData>).data.parsed;
        const info = parsed?.info;
        if (!info) continue;
        const rawAmount = Number(info.tokenAmount?.amount ?? "0");
        if (rawAmount === 0) continue;
        const decimals: number = info.tokenAmount?.decimals ?? 0;
        const mint: string = info.mint;
        rawTokens.push({ mint, rawAmount, decimals });
        splMints.push(mint);
      }

      const allMints = [SOL_MINT, ...splMints];
      const [prices, tokenMeta] = await Promise.all([
        fetchPrices(allMints),
        fetchTokenMetadata(splMints),
      ]);

      const rows: AssetRow[] = [];

      const solPrice = prices[SOL_MINT] ?? null;
      const solBal = solBalance / LAMPORTS_PER_SOL;
      rows.push({
        mint: SOL_MINT,
        symbol: "SOL",
        name: "Solana",
        logoURI: SOL_LOGO,
        balance: solBal,
        decimals: 9,
        usdPrice: solPrice,
        usdValue: solPrice !== null ? solBal * solPrice : null,
      });

      for (const { mint, rawAmount, decimals } of rawTokens) {
        const meta = tokenMeta[mint];
        const balance = rawAmount / 10 ** decimals;
        const price = prices[mint] ?? null;

        rows.push({
          mint,
          symbol: meta?.symbol ?? mint.slice(0, 4) + "...",
          name: meta?.name ?? "Unknown Token",
          logoURI: getTokenIcon(meta),
          balance,
          decimals,
          usdPrice: price,
          usdValue: price !== null ? balance * price : null,
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

      setAssets(rows);
      setTotalUsd(total);
    } catch (err) {
      console.error("Failed to fetch wallet assets:", err);
    } finally {
      setLoading(false);
    }
  }, [publicKey, connection]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { assets, totalUsd, loading, refresh };
}
