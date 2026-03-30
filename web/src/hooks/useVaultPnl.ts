"use client";

import { useEffect, useState, useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { VaultTxEntry } from "@/lib/vaultHistory";

export interface VaultPnl {
  entries: VaultTxEntry[];
  totalDeposited: number;
  totalWithdrawn: number;
  netDeposited: number;
  /** Current vault value minus net deposited USDC */
  pnl: number | null;
  /** PnL as percentage of net deposited */
  pnlPercent: number | null;
}

interface ApiResponse {
  entries: VaultTxEntry[];
  totalDeposited: number;
  totalWithdrawn: number;
  netDeposited: number;
  error?: string;
}

export function useVaultPnl(currentValueUsd: number | null) {
  const { publicKey } = useWallet();
  const [data, setData] = useState<VaultPnl | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ownerKey = publicKey?.toBase58() ?? null;

  const refresh = useCallback(async () => {
    if (!ownerKey) {
      setData(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/vault-history?owner=${ownerKey}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }

      const json: ApiResponse = await res.json();

      const pnl =
        currentValueUsd !== null ? currentValueUsd - json.netDeposited : null;
      const pnlPercent =
        pnl !== null && json.netDeposited > 0
          ? (pnl / json.netDeposited) * 100
          : null;

      setData({
        entries: json.entries,
        totalDeposited: json.totalDeposited,
        totalWithdrawn: json.totalWithdrawn,
        netDeposited: json.netDeposited,
        pnl,
        pnlPercent,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [ownerKey, currentValueUsd]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, error, refresh };
}
