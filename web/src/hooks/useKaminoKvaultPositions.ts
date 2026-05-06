"use client";

import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { onBalanceRefresh } from "@/lib/refreshEvent";

export interface KaminoKvaultPosition {
  vaultAddress: string;
  vaultName: string;
  stakedShares: string;
  unstakedShares: string;
  totalShares: string;
  tokenMint: string | null;
  tokenMintDecimals: number | null;
  sharesMint: string | null;
  tokensPerShare: string | null;
  sharePrice: string | null;
  tokenPrice: string | null;
  apy: string | null;
  underlyingAmount: number | null;
  underlyingUsd: number | null;
}

interface PositionsResponse {
  success?: boolean;
  positions?: KaminoKvaultPosition[] | KaminoKvaultPosition | null;
  error?: string;
}

export function useKaminoKvaultPositions(owner: PublicKey | null) {
  const [positions, setPositions] = useState<KaminoKvaultPosition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ownerKey = owner?.toBase58() ?? null;

  const refresh = useCallback(async () => {
    if (!ownerKey) {
      setPositions([]);
      setError(null);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/kamino/kvault/positions?owner=${ownerKey}`);
      const data = (await res.json()) as PositionsResponse;
      if (!res.ok || !data.success) {
        throw new Error(data.error ?? "Failed to load Kamino positions");
      }
      const raw = data.positions;
      setPositions(Array.isArray(raw) ? raw : raw ? [raw] : []);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ownerKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => onBalanceRefresh(refresh), [refresh]);

  return { positions, loading, error, refresh };
}
