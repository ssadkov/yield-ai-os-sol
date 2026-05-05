"use client";

import { useState, useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { setAllowedPrograms, fetchVaultAccount } from "@/lib/vault";
import { triggerBalanceRefresh } from "@/lib/refreshEvent";
import { SOL_MINT, USDC_MINT_STR } from "@/lib/constants";
import type { AssetRow } from "@/lib/portfolioAssets";

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

type PendingAction =
  | { kind: "rebalance" }
  | {
      kind: "individual_swap";
      inputMint: string;
      outputMint: string;
      amount: string;
      amountUsd: number;
    };

export function useRebalance() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { publicKey, signTransaction, signAllTransactions } = wallet;

  const [rebalancing, setRebalancing] = useState(false);
  const [result, setResult] = useState<RebalanceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsWhitelist, setNeedsWhitelist] = useState(false);
  const [pendingPrograms, setPendingPrograms] = useState<string[]>([]);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [convertingMint, setConvertingMint] = useState<string | null>(null);

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

  const callIndividualSwapApi = useCallback(
    async (swap: Extract<PendingAction, { kind: "individual_swap" }>): Promise<RebalanceResult> => {
      const res = await fetch("/api/rebalance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerPubkey: publicKey!.toBase58(),
          action: "individual_swap",
          inputMint: swap.inputMint,
          outputMint: swap.outputMint,
          amount: swap.amount,
          amountUsd: swap.amountUsd,
        }),
      });
      return res.json();
    },
    [publicKey],
  );

  const handleResult = useCallback((data: RebalanceResult) => {
    setResult(data);
    if (data.status === "needs_whitelist" && data.missingPrograms?.length) {
      setNeedsWhitelist(true);
      setPendingPrograms(data.missingPrograms);
      return;
    }
    if (data.status === "error") {
      setError(data.error ?? "Rebalance failed");
    }
    if (data.status === "success") {
      triggerBalanceRefresh();
    }
  }, []);

  const rebalance = useCallback(async () => {
    if (!publicKey) return;
    setRebalancing(true);
    setError(null);
    setResult(null);
    setNeedsWhitelist(false);

    try {
      setPendingAction({ kind: "rebalance" });
      const data = await callRebalanceApi();
      handleResult(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setRebalancing(false);
    }
  }, [publicKey, callRebalanceApi, handleResult]);

  const convertAssetToUsdc = useCallback(
    async (asset: AssetRow) => {
      if (
        !publicKey ||
        asset.mint === USDC_MINT_STR ||
        asset.mint === SOL_MINT ||
        BigInt(asset.rawAmount) === BigInt(0)
      ) {
        return;
      }

      setRebalancing(true);
      setConvertingMint(asset.mint);
      setError(null);
      setResult(null);
      setNeedsWhitelist(false);

      const action: Extract<PendingAction, { kind: "individual_swap" }> = {
        kind: "individual_swap",
        inputMint: asset.mint,
        outputMint: USDC_MINT_STR,
        amount: asset.rawAmount,
        amountUsd: asset.usdValue ?? 0,
      };

      try {
        setPendingAction(action);
        const data = await callIndividualSwapApi(action);
        handleResult(data);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        setRebalancing(false);
        setConvertingMint(null);
      }
    },
    [publicKey, callIndividualSwapApi, handleResult],
  );

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

      const data =
        pendingAction?.kind === "individual_swap"
          ? await callIndividualSwapApi(pendingAction)
          : await callRebalanceApi();
      handleResult(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setRebalancing(false);
    }
  }, [pendingPrograms, pendingAction, connection, publicKey, getProvider, callRebalanceApi, callIndividualSwapApi, handleResult]);

  return {
    rebalance,
    convertAssetToUsdc,
    approveWhitelist,
    rebalancing,
    convertingMint,
    result,
    error,
    needsWhitelist,
  };
}
