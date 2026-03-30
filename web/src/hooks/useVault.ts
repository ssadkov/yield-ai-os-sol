"use client";

import { useEffect, useState, useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import {
  fetchVaultAccount,
  getVaultUsdcBalance,
  initializeVault,
  depositUsdc,
  withdrawUsdc,
  parseStrategy,
  type VaultAccount,
  type StrategyName,
} from "@/lib/vault";
import { USDC_DECIMALS } from "@/lib/constants";

export function useVault() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { publicKey, signTransaction, signAllTransactions } = wallet;

  const [vault, setVault] = useState<VaultAccount | null>(null);
  const [vaultUsdcBalance, setVaultUsdcBalance] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [txPending, setTxPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTxSig, setLastTxSig] = useState<string | null>(null);

  const getProvider = useCallback(() => {
    if (!publicKey || !signTransaction || !signAllTransactions) return null;
    return new AnchorProvider(
      connection,
      { publicKey, signTransaction, signAllTransactions } as never,
      { preflightCommitment: "confirmed" }
    );
  }, [connection, publicKey, signTransaction, signAllTransactions]);

  const refresh = useCallback(async () => {
    if (!publicKey) {
      setVault(null);
      setVaultUsdcBalance(0);
      return;
    }
    setLoading(true);
    try {
      const [v, bal] = await Promise.all([
        fetchVaultAccount(connection, publicKey),
        getVaultUsdcBalance(connection, publicKey),
      ]);
      setVault(v);
      setVaultUsdcBalance(bal);
    } catch (err) {
      console.error("Failed to fetch vault:", err);
    } finally {
      setLoading(false);
    }
  }, [publicKey, connection]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createVault = useCallback(
    async (strategy: StrategyName) => {
      const provider = getProvider();
      if (!provider) throw new Error("Wallet not connected");
      setTxPending(true);
      setError(null);
      try {
        const sig = await initializeVault(provider, strategy);
        setLastTxSig(sig);
        await refresh();
        return sig;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        throw err;
      } finally {
        setTxPending(false);
      }
    },
    [getProvider, refresh]
  );

  const deposit = useCallback(
    async (uiAmount: number) => {
      const provider = getProvider();
      if (!provider) throw new Error("Wallet not connected");
      setTxPending(true);
      setError(null);
      try {
        const rawAmount = Math.floor(uiAmount * 10 ** USDC_DECIMALS);
        const sig = await depositUsdc(provider, rawAmount);
        setLastTxSig(sig);
        await refresh();
        return sig;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        throw err;
      } finally {
        setTxPending(false);
      }
    },
    [getProvider, refresh]
  );

  const withdraw = useCallback(
    async (uiAmount: number) => {
      const provider = getProvider();
      if (!provider) throw new Error("Wallet not connected");
      setTxPending(true);
      setError(null);
      try {
        const rawAmount = Math.floor(uiAmount * 10 ** USDC_DECIMALS);
        const sig = await withdrawUsdc(provider, rawAmount);
        setLastTxSig(sig);
        await refresh();
        return sig;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        throw err;
      } finally {
        setTxPending(false);
      }
    },
    [getProvider, refresh]
  );

  const strategyName: StrategyName | null = vault
    ? parseStrategy(vault.strategy)
    : null;

  return {
    vault,
    vaultUsdcBalance,
    strategyName,
    loading,
    txPending,
    error,
    lastTxSig,
    createVault,
    deposit,
    withdraw,
    refresh,
  };
}
