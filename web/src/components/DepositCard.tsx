"use client";

import { useState, useMemo, useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { useVault } from "@/hooks/useVault";
import { useVaultAssets } from "@/hooks/useVaultAssets";
import { useWalletAssets } from "@/hooks/useWalletAssets";
import { USDC_MINT_STR, USDC_DECIMALS } from "@/lib/constants";
import { deriveVaultPda, setAllowedPrograms } from "@/lib/vault";
import { triggerBalanceRefresh } from "@/lib/refreshEvent";

type Tab = "deposit" | "withdraw";
type WithdrawStep =
  | "idle"
  | "converting"
  | "whitelist_needed"
  | "approving"
  | "withdrawing";

interface ConvertResult {
  status: string;
  missingPrograms?: string[];
  error?: string;
}

function QuickButtons({
  onHalf,
  onMax,
}: {
  onHalf: () => void;
  onMax: () => void;
}) {
  return (
    <div className="flex gap-1">
      <button
        type="button"
        onClick={onHalf}
        className="cursor-pointer text-[11px] px-2 py-0.5 rounded border border-border bg-muted/60 text-muted-foreground hover:text-foreground hover:border-muted-foreground/50 transition-colors"
      >
        50%
      </button>
      <button
        type="button"
        onClick={onMax}
        className="cursor-pointer text-[11px] px-2 py-0.5 rounded border border-border bg-muted/60 text-muted-foreground hover:text-foreground hover:border-muted-foreground/50 transition-colors"
      >
        MAX
      </button>
    </div>
  );
}

function formatAmount(n: number): string {
  return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

export function DepositCard() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { publicKey, signTransaction, signAllTransactions } = wallet;
  const { vault, vaultUsdcBalance, txPending, error, deposit, withdraw, refresh } =
    useVault();
  const { assets: walletAssets } = useWalletAssets();
  const vaultPda = publicKey && vault ? deriveVaultPda(publicKey)[0] : null;
  const { assets: vaultAssets, refresh: refreshVaultAssets } =
    useVaultAssets(vaultPda);

  const [tab, setTab] = useState<Tab>("deposit");
  const [amount, setAmount] = useState("");
  const [withdrawStep, setWithdrawStep] = useState<WithdrawStep>("idle");
  const [convertError, setConvertError] = useState<string | null>(null);
  const [pendingPrograms, setPendingPrograms] = useState<string[]>([]);

  const walletUsdc = useMemo(() => {
    const row = walletAssets.find((a) => a.mint === USDC_MINT_STR);
    return row?.balance ?? 0;
  }, [walletAssets]);

  const vaultUsdc = vaultUsdcBalance / 10 ** USDC_DECIMALS;

  const hasNonUsdcHoldings = useMemo(() => {
    return vaultAssets.some(
      (a) => a.mint !== USDC_MINT_STR && a.balance > 0
    );
  }, [vaultAssets]);

  const getProvider = useCallback(() => {
    if (!publicKey || !signTransaction || !signAllTransactions) return null;
    return new AnchorProvider(
      connection,
      { publicKey, signTransaction, signAllTransactions } as never,
      { preflightCommitment: "confirmed" }
    );
  }, [connection, publicKey, signTransaction, signAllTransactions]);

  if (!publicKey || !vault) return null;

  const isDeposit = tab === "deposit";
  const maxAmount = isDeposit ? walletUsdc : vaultUsdc;
  const busy =
    txPending ||
    withdrawStep === "converting" ||
    withdrawStep === "approving" ||
    withdrawStep === "withdrawing";

  const setHalf = () => {
    const v = maxAmount / 2;
    if (v > 0) setAmount(formatAmount(v));
  };
  const setMax = () => {
    if (maxAmount > 0) setAmount(formatAmount(maxAmount));
  };

  const handleSubmit = async () => {
    const val = parseFloat(amount);
    if (isNaN(val) || val <= 0) return;
    try {
      if (isDeposit) {
        await deposit(val);
      } else {
        await withdraw(val);
      }
      setAmount("");
    } catch {
      // error shown via hook
    }
  };

  const callConvertAll = async (): Promise<ConvertResult> => {
    const res = await fetch("/api/rebalance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ownerPubkey: publicKey!.toBase58(),
        action: "convert_all",
      }),
    });
    return res.json();
  };

  const doWithdrawAll = async () => {
    setWithdrawStep("withdrawing");
    await refresh();
    const freshBalance = vaultUsdcBalance;
    if (freshBalance > 0) {
      const uiAmount = freshBalance / 10 ** USDC_DECIMALS;
      await withdraw(uiAmount);
    }
    setWithdrawStep("idle");
  };

  const handleWithdrawAll = async () => {
    setConvertError(null);
    setPendingPrograms([]);

    try {
      if (hasNonUsdcHoldings) {
        setWithdrawStep("converting");
        const data = await callConvertAll();

        if (data.status === "error") {
          setConvertError(data.error ?? "Conversion failed");
          setWithdrawStep("idle");
          return;
        }

        if (
          data.status === "needs_whitelist" &&
          data.missingPrograms?.length
        ) {
          setPendingPrograms(data.missingPrograms);
          setWithdrawStep("whitelist_needed");
          return;
        }

        triggerBalanceRefresh();
      }

      await doWithdrawAll();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setConvertError(msg);
      setWithdrawStep("idle");
    }
  };

  const handleApproveAndWithdraw = async () => {
    setConvertError(null);

    try {
      const provider = getProvider();
      if (!provider) {
        setConvertError("Wallet not connected");
        return;
      }

      setWithdrawStep("approving");
      const existingSet = new Set(
        (vault.allowedPrograms ?? []).map((p: PublicKey) => p.toBase58())
      );
      for (const p of pendingPrograms) existingSet.add(p);
      const mergedPrograms = [...existingSet].map((p) => new PublicKey(p));
      await setAllowedPrograms(provider, mergedPrograms);
      setPendingPrograms([]);

      // Retry convert_all after whitelist approval
      setWithdrawStep("converting");
      const data = await callConvertAll();

      if (data.status === "error") {
        setConvertError(data.error ?? "Conversion failed after approval");
        setWithdrawStep("idle");
        return;
      }

      if (data.status === "needs_whitelist") {
        setConvertError("Still missing whitelist programs. Please try Rebalance first.");
        setWithdrawStep("idle");
        return;
      }

      triggerBalanceRefresh();
      await doWithdrawAll();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setConvertError(msg);
      setWithdrawStep("idle");
    }
  };

  const resetWithdrawState = () => {
    setWithdrawStep("idle");
    setConvertError(null);
    setPendingPrograms([]);
  };

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      {/* Tabs */}
      <div className="flex gap-1 mb-4 p-1 bg-muted/40 rounded-lg">
        <button
          type="button"
          onClick={() => {
            setTab("deposit");
            setAmount("");
            resetWithdrawState();
          }}
          className={`cursor-pointer flex-1 py-2 text-sm font-medium rounded-md transition-colors ${
            isDeposit
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Deposit
        </button>
        <button
          type="button"
          onClick={() => {
            setTab("withdraw");
            setAmount("");
            resetWithdrawState();
          }}
          className={`cursor-pointer flex-1 py-2 text-sm font-medium rounded-md transition-colors ${
            !isDeposit
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Withdraw
        </button>
      </div>

      {/* Balance hint */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-muted-foreground">
          {isDeposit ? "Wallet" : "Vault"} USDC
        </span>
        <span className="text-xs font-mono text-muted-foreground">
          {maxAmount.toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 6,
          })}
        </span>
      </div>

      {/* Input row */}
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1">
          <input
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="w-full py-3 px-4 pr-16 rounded-lg bg-accent border border-border text-base font-mono focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-medium">
            USDC
          </span>
        </div>
        <QuickButtons onHalf={setHalf} onMax={setMax} />
      </div>

      {/* Action button */}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={busy || !amount || parseFloat(amount) <= 0}
        className={`cursor-pointer w-full py-3 px-4 rounded-lg font-semibold text-base transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
          isDeposit
            ? "bg-success text-white hover:bg-success/90"
            : "bg-destructive text-white hover:bg-destructive/90"
        }`}
      >
        {busy
          ? "Processing..."
          : isDeposit
            ? "Deposit USDC to AI agent wallet"
            : "Withdraw USDC"}
      </button>

      {/* Withdraw all as USDC */}
      {!isDeposit && withdrawStep !== "whitelist_needed" && withdrawStep !== "approving" && (
        <div className="mt-3 pt-3 border-t border-border">
          <button
            type="button"
            onClick={handleWithdrawAll}
            disabled={busy || (vaultUsdc === 0 && !hasNonUsdcHoldings)}
            className="cursor-pointer w-full py-2.5 px-4 rounded-lg font-medium text-sm border border-border bg-accent text-foreground hover:bg-accent/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {withdrawStep === "converting"
              ? "Converting to USDC..."
              : withdrawStep === "withdrawing"
                ? "Withdrawing..."
                : hasNonUsdcHoldings
                  ? "Withdraw all as USDC"
                  : "Withdraw all USDC"}
          </button>
          {hasNonUsdcHoldings && withdrawStep === "idle" && (
            <p className="text-[11px] text-muted-foreground mt-1.5 text-center">
              Converts all vault tokens to USDC, then withdraws
            </p>
          )}
        </div>
      )}

      {/* Whitelist approval prompt */}
      {!isDeposit && (withdrawStep === "whitelist_needed" || withdrawStep === "approving") && (
        <div className="mt-3 p-3 bg-primary/10 border border-primary/30 rounded space-y-2">
          <div className="text-sm font-medium">One-time setup required</div>
          <div className="text-xs text-muted-foreground">
            Your vault needs to whitelist swap programs before tokens can be
            converted to USDC. Sign this one-time transaction, then the
            withdrawal will continue automatically.
          </div>
          <button
            type="button"
            onClick={handleApproveAndWithdraw}
            disabled={busy}
            className="cursor-pointer text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {withdrawStep === "approving"
              ? "Approving..."
              : "Approve & Withdraw all"}
          </button>
        </div>
      )}

      {(error || convertError) && (
        <div className="text-sm text-destructive mt-3 p-2 bg-destructive/10 rounded">
          {convertError || error}
        </div>
      )}
    </div>
  );
}
