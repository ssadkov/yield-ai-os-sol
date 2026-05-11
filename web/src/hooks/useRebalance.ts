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
    }
  | {
      kind: "jupiter_borrow_deposit";
      vaultId: number;
      amountRaw: string;
    }
  | {
      kind: "jupiter_borrow_withdraw";
      vaultId: number;
      positionId: number;
    }
  | {
      kind: "jupiter_borrow_usdc";
      vaultId: number;
      positionId: number;
      amountRaw: string;
    }
  | {
      kind: "jupiter_repay_usdc";
      vaultId: number;
      positionId: number;
      amountRaw: string;
      max?: boolean;
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
  const [lastActionLabel, setLastActionLabel] = useState<string>("Action");
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

  const callJupiterBorrowDepositApi = useCallback(
    async (deposit: Extract<PendingAction, { kind: "jupiter_borrow_deposit" }>): Promise<RebalanceResult> => {
      const res = await fetch("/api/jupiter/borrow/deposit-collateral", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerPubkey: publicKey!.toBase58(),
          vaultId: deposit.vaultId,
          amountRaw: deposit.amountRaw,
        }),
      });
      return res.json();
    },
    [publicKey],
  );

  const callJupiterBorrowWithdrawApi = useCallback(
    async (withdraw: Extract<PendingAction, { kind: "jupiter_borrow_withdraw" }>): Promise<RebalanceResult> => {
      const res = await fetch("/api/jupiter/borrow/withdraw-collateral", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerPubkey: publicKey!.toBase58(),
          vaultId: withdraw.vaultId,
          positionId: withdraw.positionId,
        }),
      });
      return res.json();
    },
    [publicKey],
  );

  const callJupiterBorrowUsdcApi = useCallback(
    async (borrow: Extract<PendingAction, { kind: "jupiter_borrow_usdc" }>): Promise<RebalanceResult> => {
      const res = await fetch("/api/jupiter/borrow/borrow-usdc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerPubkey: publicKey!.toBase58(),
          vaultId: borrow.vaultId,
          positionId: borrow.positionId,
          amountRaw: borrow.amountRaw,
        }),
      });
      return res.json();
    },
    [publicKey],
  );

  const callJupiterRepayUsdcApi = useCallback(
    async (repay: Extract<PendingAction, { kind: "jupiter_repay_usdc" }>): Promise<RebalanceResult> => {
      const res = await fetch("/api/jupiter/borrow/repay-usdc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerPubkey: publicKey!.toBase58(),
          vaultId: repay.vaultId,
          positionId: repay.positionId,
          amountRaw: repay.amountRaw,
          max: repay.max ?? false,
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
      setLastActionLabel("Rebalance");
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
        setLastActionLabel("Swap");
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

  const swapVaultAsset = useCallback(
    async (args: {
      inputMint: string;
      outputMint: string;
      amount: string;
      amountUsd: number;
    }) => {
      if (!publicKey || BigInt(args.amount) === BigInt(0)) return;

      setRebalancing(true);
      setError(null);
      setResult(null);
      setNeedsWhitelist(false);

      const action: Extract<PendingAction, { kind: "individual_swap" }> = {
        kind: "individual_swap",
        inputMint: args.inputMint,
        outputMint: args.outputMint,
        amount: args.amount,
        amountUsd: args.amountUsd,
      };

      try {
        setPendingAction(action);
        setLastActionLabel("Trade");
        const data = await callIndividualSwapApi(action);
        handleResult(data);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        setRebalancing(false);
      }
    },
    [publicKey, callIndividualSwapApi, handleResult],
  );

  const depositJupiterBorrowCollateral = useCallback(
    async (args: {
      vaultId: number;
      amountRaw: string;
    }) => {
      if (!publicKey || BigInt(args.amountRaw) === BigInt(0)) return;

      setRebalancing(true);
      setError(null);
      setResult(null);
      setNeedsWhitelist(false);

      const action: Extract<PendingAction, { kind: "jupiter_borrow_deposit" }> = {
        kind: "jupiter_borrow_deposit",
        vaultId: args.vaultId,
        amountRaw: args.amountRaw,
      };

      try {
        setPendingAction(action);
        setLastActionLabel("Jupiter Lend deposit");
        const data = await callJupiterBorrowDepositApi(action);
        handleResult(data);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        setRebalancing(false);
      }
    },
    [publicKey, callJupiterBorrowDepositApi, handleResult],
  );

  const withdrawJupiterBorrowCollateral = useCallback(
    async (args: {
      vaultId: number;
      positionId: number;
    }) => {
      if (!publicKey) return;

      setRebalancing(true);
      setError(null);
      setResult(null);
      setNeedsWhitelist(false);

      const action: Extract<PendingAction, { kind: "jupiter_borrow_withdraw" }> = {
        kind: "jupiter_borrow_withdraw",
        vaultId: args.vaultId,
        positionId: args.positionId,
      };

      try {
        setPendingAction(action);
        setLastActionLabel("Jupiter Lend withdraw");
        const data = await callJupiterBorrowWithdrawApi(action);
        handleResult(data);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        setRebalancing(false);
      }
    },
    [publicKey, callJupiterBorrowWithdrawApi, handleResult],
  );

  const borrowJupiterUsdc = useCallback(
    async (args: {
      vaultId: number;
      positionId: number;
      amountRaw: string;
    }) => {
      if (!publicKey || BigInt(args.amountRaw) === BigInt(0)) return;

      setRebalancing(true);
      setError(null);
      setResult(null);
      setNeedsWhitelist(false);

      const action: Extract<PendingAction, { kind: "jupiter_borrow_usdc" }> = {
        kind: "jupiter_borrow_usdc",
        vaultId: args.vaultId,
        positionId: args.positionId,
        amountRaw: args.amountRaw,
      };

      try {
        setPendingAction(action);
        setLastActionLabel("Jupiter Lend borrow");
        const data = await callJupiterBorrowUsdcApi(action);
        handleResult(data);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        setRebalancing(false);
      }
    },
    [publicKey, callJupiterBorrowUsdcApi, handleResult],
  );

  const repayJupiterUsdc = useCallback(
    async (args: {
      vaultId: number;
      positionId: number;
      amountRaw: string;
      max?: boolean;
    }) => {
      if (!publicKey) return;
      if (!args.max && BigInt(args.amountRaw) === BigInt(0)) return;

      setRebalancing(true);
      setError(null);
      setResult(null);
      setNeedsWhitelist(false);

      const action: Extract<PendingAction, { kind: "jupiter_repay_usdc" }> = {
        kind: "jupiter_repay_usdc",
        vaultId: args.vaultId,
        positionId: args.positionId,
        amountRaw: args.amountRaw,
        max: args.max,
      };

      try {
        setPendingAction(action);
        setLastActionLabel("Jupiter Lend repay");
        const data = await callJupiterRepayUsdcApi(action);
        handleResult(data);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        setRebalancing(false);
      }
    },
    [publicKey, callJupiterRepayUsdcApi, handleResult],
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
          : pendingAction?.kind === "jupiter_borrow_deposit"
            ? await callJupiterBorrowDepositApi(pendingAction)
            : pendingAction?.kind === "jupiter_borrow_withdraw"
              ? await callJupiterBorrowWithdrawApi(pendingAction)
              : pendingAction?.kind === "jupiter_borrow_usdc"
                ? await callJupiterBorrowUsdcApi(pendingAction)
                : pendingAction?.kind === "jupiter_repay_usdc"
                  ? await callJupiterRepayUsdcApi(pendingAction)
            : await callRebalanceApi();
      handleResult(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setRebalancing(false);
    }
  }, [pendingPrograms, pendingAction, connection, publicKey, getProvider, callRebalanceApi, callIndividualSwapApi, callJupiterBorrowDepositApi, callJupiterBorrowWithdrawApi, callJupiterBorrowUsdcApi, callJupiterRepayUsdcApi, handleResult]);

  return {
    rebalance,
    convertAssetToUsdc,
    swapVaultAsset,
    depositJupiterBorrowCollateral,
    withdrawJupiterBorrowCollateral,
    borrowJupiterUsdc,
    repayJupiterUsdc,
    approveWhitelist,
    rebalancing,
    convertingMint,
    result,
    error,
    needsWhitelist,
    lastActionLabel,
  };
}
