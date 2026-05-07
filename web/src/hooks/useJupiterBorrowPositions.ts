"use client";

import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { onBalanceRefresh } from "@/lib/refreshEvent";

export interface JupiterBorrowPosition {
  protocol: "Jupiter";
  vaultId: number;
  positionId: number;
  market: string;
  collateralSymbol: string;
  collateralMint: string;
  collateralRaw: string;
  collateralAmount: number;
  borrowSymbol: string;
  borrowMint: string;
  debtRaw: string;
  debtAmount: number;
  collateralUsd: number | null;
  debtUsd: number | null;
  netUsd: number | null;
  depositApy: number | null;
  borrowAPY: number | null;
  netApy: number | null;
  tokenAccount: string;
}

interface PositionsResponse {
  success?: boolean;
  positions?: JupiterBorrowPosition[];
  error?: string;
}

export function useJupiterBorrowPositions(owner: PublicKey | null) {
  const [positions, setPositions] = useState<JupiterBorrowPosition[]>([]);
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
      const res = await fetch(`/api/jupiter/borrow/positions?owner=${ownerKey}`);
      const data = (await res.json()) as PositionsResponse;
      if (!res.ok || !data.success) {
        throw new Error(data.error ?? "Failed to load Jupiter Lend positions");
      }
      setPositions(data.positions ?? []);
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
