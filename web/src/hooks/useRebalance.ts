"use client";

import { useState, useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { setAllowedPrograms, fetchVaultAccount } from "@/lib/vault";
import { triggerBalanceRefresh } from "@/lib/refreshEvent";

export interface RebalanceSwap {
  from: { symbol: string; mint: string };
  to: { symbol: string; mint: string };
  rawAmount: string;
  amountUsd: number;
}

export interface RebalanceResult {
  status: "success" | "needs_whitelist" | "no_rebalance_needed" | "error";
  signatures?: string[];
  missingPrograms?: string[];
  swaps?: RebalanceSwap[];
  error?: string;
}

export function useRebalance() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { publicKey, signTransaction, signAllTransactions } = wallet;

  const [rebalancing, setRebalancing] = useState(false);
  const [result, setResult] = useState<RebalanceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsWhitelist, setNeedsWhitelist] = useState(false);
  const [pendingPrograms, setPendingPrograms] = useState<string[]>([]);

  const getProvider = useCallback(() => {
    if (!publicKey || !signTransaction || !signAllTransactions) return null;
    return new AnchorProvider(
      connection,
      { publicKey, signTransaction, signAllTransactions } as never,
      { preflightCommitment: "confirmed" },
    );
  }, [connection, publicKey, signTransaction, signAllTransactions]);

  const callRebalanceApi = useCallback(async (): Promise<RebalanceResult> => {
    const res = await fetch("/api/rebalance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerPubkey: publicKey!.toBase58() }),
    });
    return res.json();
  }, [publicKey]);

  const rebalance = useCallback(async () => {
    if (!publicKey) return;
    setRebalancing(true);
    setError(null);
    setResult(null);
    setNeedsWhitelist(false);

    try {
      const data = await callRebalanceApi();

      if (data.status === "needs_whitelist" && data.missingPrograms?.length) {
        setNeedsWhitelist(true);
        setPendingPrograms(data.missingPrograms);
        setResult(data);
        return;
      }

      setResult(data);
      if (data.status === "error") {
        setError(data.error ?? "Rebalance failed");
      }
      if (data.status === "success") {
        triggerBalanceRefresh();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setRebalancing(false);
    }
  }, [publicKey, callRebalanceApi]);

  const approveWhitelist = useCallback(async () => {
    if (!pendingPrograms.length) return;
    setRebalancing(true);
    setError(null);

    try {
      const provider = getProvider();
      if (!provider) {
        setError("Wallet not connected");
        return;
      }

      const vault = await fetchVaultAccount(connection, publicKey!);
      const existingSet = new Set(
        (vault?.allowedPrograms ?? []).map((p) => p.toBase58())
      );
      for (const p of pendingPrograms) existingSet.add(p);
      const mergedPrograms = [...existingSet].map((p) => new PublicKey(p));
      await setAllowedPrograms(provider, mergedPrograms);

      setNeedsWhitelist(false);
      setPendingPrograms([]);

      // Retry rebalance after whitelisting
      const data = await callRebalanceApi();
      setResult(data);
      if (data.status === "error") {
        setError(data.error ?? "Rebalance failed");
      }
      if (data.status === "success") {
        triggerBalanceRefresh();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setRebalancing(false);
    }
  }, [pendingPrograms, getProvider, callRebalanceApi]);

  return {
    rebalance,
    approveWhitelist,
    rebalancing,
    result,
    error,
    needsWhitelist,
  };
}
