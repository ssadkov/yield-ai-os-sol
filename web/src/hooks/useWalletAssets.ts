"use client";

import { useEffect, useState, useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { fetchPortfolioAssets, type AssetRow } from "@/lib/portfolioAssets";
import { onBalanceRefresh } from "@/lib/refreshEvent";

export type { AssetRow };

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
      const { assets: rows, totalUsd: total } = await fetchPortfolioAssets(
        connection,
        publicKey
      );
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

  // Refresh only after successful on-chain actions.
  useEffect(() => onBalanceRefresh(refresh), [refresh]);

  return { assets, totalUsd, loading, refresh };
}
