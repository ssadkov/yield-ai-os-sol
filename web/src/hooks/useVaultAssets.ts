"use client";

import { useEffect, useState, useCallback } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { fetchPortfolioAssets, type AssetRow, type FetchOptions } from "@/lib/portfolioAssets";
import { onBalanceRefresh } from "@/lib/refreshEvent";

const VAULT_OPTS: FetchOptions = { includeSol: false };

export type { AssetRow };

/**
 * Pass vault PDA or null. Uses a stable base58 key for deps so a new PublicKey
 * instance each render does not retrigger fetch loops.
 */
export function useVaultAssets(vaultPda: PublicKey | null) {
  const { connection } = useConnection();
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [totalUsd, setTotalUsd] = useState<number>(0);
  const [loading, setLoading] = useState(false);

  const vaultKey = vaultPda?.toBase58() ?? null;

  const refresh = useCallback(async () => {
    if (!vaultKey) {
      setAssets([]);
      setTotalUsd(0);
      return;
    }

    const owner = new PublicKey(vaultKey);
    setLoading(true);
    try {
      const [{ assets: rows, totalUsd: total }, yieldsRes] = await Promise.all([
        fetchPortfolioAssets(connection, owner, VAULT_OPTS),
        fetch("/api/yields").then((r) => r.json()).catch(() => ({})),
      ]);

      const merged = rows.map((r) => ({
        ...r,
        apr: yieldsRes[r.symbol] || yieldsRes[r.name],
      }));

      setAssets(merged);
      setTotalUsd(total);
    } catch (err) {
      console.error("Failed to fetch vault assets:", err);
    } finally {
      setLoading(false);
    }
  }, [vaultKey, connection]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Refresh only after successful on-chain actions.
  useEffect(() => onBalanceRefresh(refresh), [refresh]);

  return { assets, totalUsd, loading, refresh };
}
