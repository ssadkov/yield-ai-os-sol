"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { VaultTxEntry } from "@/lib/vaultHistory";
import { onBalanceRefresh } from "@/lib/refreshEvent";

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
  hasSplActivity?: boolean;
  error?: string;
}

export interface VaultPnlWithCaveat extends VaultPnl {
  hasSplActivity: boolean;
}

function computeNetFromEntries(
  entries: VaultTxEntry[],
  priceByMint: Record<string, number | null | undefined>,
): { totalDeposited: number; totalWithdrawn: number; netDeposited: number } {
  let totalDeposited = 0;
  let totalWithdrawn = 0;
  for (const e of entries) {
    let usd: number | null = e.amountUsdc;
    if (usd == null) {
      const price = priceByMint[e.mint];
      if (price != null && price > 0) {
        const ui = Number(e.amountRaw) / 10 ** e.decimals;
        usd = ui * price;
      }
    }
    if (usd == null) continue;
    if (e.type === "deposit") totalDeposited += usd;
    else totalWithdrawn += usd;
  }
  return { totalDeposited, totalWithdrawn, netDeposited: totalDeposited - totalWithdrawn };
}

export function useVaultPnl(
  currentValueUsd: number | null,
  priceByMint: Record<string, number | null | undefined> = {},
) {
  const { publicKey } = useWallet();
  const [data, setData] = useState<VaultPnlWithCaveat | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ownerKey = publicKey?.toBase58() ?? null;

  const currentValueUsdRef = useRef(currentValueUsd);
  currentValueUsdRef.current = currentValueUsd;
  const priceByMintRef = useRef(priceByMint);
  priceByMintRef.current = priceByMint;

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

      const computed = computeNetFromEntries(json.entries, priceByMintRef.current);
      const cv = currentValueUsdRef.current;
      const pnl = cv !== null ? cv - computed.netDeposited : null;
      const pnlPercent =
        pnl !== null && computed.netDeposited > 0
          ? (pnl / computed.netDeposited) * 100
          : null;

      setData({
        entries: json.entries,
        totalDeposited: computed.totalDeposited,
        totalWithdrawn: computed.totalWithdrawn,
        netDeposited: computed.netDeposited,
        pnl,
        pnlPercent,
        hasSplActivity: Boolean(json.hasSplActivity),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [ownerKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Recompute PnL when vault USD total or live prices update — no extra API call.
  useEffect(() => {
    setData((prev) => {
      if (!prev) return prev;
      const computed = computeNetFromEntries(prev.entries, priceByMint);
      const pnl =
        currentValueUsd !== null ? currentValueUsd - computed.netDeposited : null;
      const pnlPercent =
        pnl !== null && computed.netDeposited > 0
          ? (pnl / computed.netDeposited) * 100
          : null;
      if (
        prev.pnl === pnl &&
        prev.pnlPercent === pnlPercent &&
        prev.netDeposited === computed.netDeposited
      )
        return prev;
      return {
        ...prev,
        totalDeposited: computed.totalDeposited,
        totalWithdrawn: computed.totalWithdrawn,
        netDeposited: computed.netDeposited,
        pnl,
        pnlPercent,
      };
    });
    // priceByMint identity changes every render; deep-compare via JSON for stability.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentValueUsd, JSON.stringify(priceByMint)]);

  useEffect(() => onBalanceRefresh(refresh), [refresh]);

  return { data, loading, error, refresh };
}
