"use client";

import { useState, useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useVault } from "@/hooks/useVault";
import { useWalletAssets } from "@/hooks/useWalletAssets";
import { USDC_MINT_STR, USDC_DECIMALS } from "@/lib/constants";

type Tab = "deposit" | "withdraw";

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

export function DepositCard() {
  const { publicKey } = useWallet();
  const { vault, vaultUsdcBalance, txPending, error, deposit, withdraw } =
    useVault();
  const { assets } = useWalletAssets();
  const [tab, setTab] = useState<Tab>("deposit");
  const [amount, setAmount] = useState("");

  const walletUsdc = useMemo(() => {
    const row = assets.find((a) => a.mint === USDC_MINT_STR);
    return row?.balance ?? 0;
  }, [assets]);

  const vaultUsdc = vaultUsdcBalance / 10 ** USDC_DECIMALS;

  if (!publicKey || !vault) return null;

  const maxAmount = tab === "deposit" ? walletUsdc : vaultUsdc;

  const setHalf = () => {
    const v = maxAmount / 2;
    if (v > 0) setAmount(v.toFixed(6).replace(/0+$/, "").replace(/\.$/, ""));
  };
  const setMax = () => {
    if (maxAmount > 0)
      setAmount(
        maxAmount.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")
      );
  };

  const handleSubmit = async () => {
    const val = parseFloat(amount);
    if (isNaN(val) || val <= 0) return;
    try {
      if (tab === "deposit") {
        await deposit(val);
      } else {
        await withdraw(val);
      }
      setAmount("");
    } catch {
      // error shown via hook
    }
  };

  const isDeposit = tab === "deposit";

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      {/* Tabs */}
      <div className="flex gap-1 mb-4 p-1 bg-muted/40 rounded-lg">
        <button
          type="button"
          onClick={() => {
            setTab("deposit");
            setAmount("");
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
        disabled={txPending || !amount || parseFloat(amount) <= 0}
        className={`cursor-pointer w-full py-3 px-4 rounded-lg font-semibold text-base transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
          isDeposit
            ? "bg-success text-white hover:bg-success/90"
            : "bg-destructive text-white hover:bg-destructive/90"
        }`}
      >
        {txPending
          ? "Processing..."
          : isDeposit
            ? "Deposit USDC"
            : "Withdraw USDC"}
      </button>

      {error && (
        <div className="text-sm text-destructive mt-3 p-2 bg-destructive/10 rounded">
          {error}
        </div>
      )}
    </div>
  );
}
