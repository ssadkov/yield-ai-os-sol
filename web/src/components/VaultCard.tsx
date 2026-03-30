"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useVault } from "@/hooks/useVault";
import { USDC_DECIMALS } from "@/lib/constants";
import type { StrategyName } from "@/lib/vault";

function formatUsdc(raw: number): string {
  const ui = raw / 10 ** USDC_DECIMALS;
  return ui.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function formatTimestamp(ts: number): string {
  if (ts === 0) return "Never";
  return new Date(ts * 1000).toLocaleString();
}

const strategyHelp: Record<StrategyName, string> = {
  Conservative: "Lower risk. Target mix: 60% USDC / 40% USDY.",
  Balanced: "Medium risk. Target mix: 30% USDC / 30% yield stables / 20% BTC / 20% equities.",
  Growth: "Higher risk. Target mix: 10% USDC / 20% sUSDe / 35% BTC / 35% equities.",
};

export function VaultCard() {
  const { publicKey } = useWallet();
  const { vault, vaultUsdcBalance, strategyName, txPending, error, withdraw, lastTxSig, refresh, loading } = useVault();
  const [withdrawAmount, setWithdrawAmount] = useState("");

  if (!publicKey) return null;

  if (!vault) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card p-6 text-center">
        <div className="text-muted-foreground text-sm">
          {loading ? "Loading vault..." : "No vault found. Create your Yield AI Agent Safe first."}
        </div>
      </div>
    );
  }

  const handleWithdraw = async () => {
    const val = parseFloat(withdrawAmount);
    if (isNaN(val) || val <= 0) return;
    try {
      await withdraw(val);
      setWithdrawAmount("");
    } catch {
      // shown via hook
    }
  };

  const lastRebalance = vault.lastRebalanceTs
    ? vault.lastRebalanceTs.toNumber()
    : 0;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Vault</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs bg-success/20 text-success px-2 py-0.5 rounded font-medium">
            Active
          </span>
          <button
            onClick={refresh}
            disabled={loading}
            className="cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "..." : "Refresh"}
          </button>
        </div>
      </div>

      <div className="space-y-3 mb-4">
        <div className="flex justify-between items-center gap-3">
          <span className="text-sm text-muted-foreground">Strategy</span>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{strategyName}</span>
            {strategyName && (
              <span className="relative inline-flex group">
                <button
                  type="button"
                  aria-label="Strategy help"
                  className="cursor-pointer select-none inline-flex items-center justify-center w-5 h-5 rounded-full border border-border text-[11px] text-muted-foreground hover:text-foreground hover:border-muted-foreground/60 transition-colors"
                >
                  i
                </button>
                <span
                  role="tooltip"
                  className="pointer-events-none absolute right-0 top-7 z-10 w-[260px] rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground shadow-lg opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 group-focus-within:opacity-100 group-focus-within:translate-y-0 transition-all"
                >
                  {strategyHelp[strategyName]}
                </span>
              </span>
            )}
            <button
              type="button"
              disabled={txPending}
              className="cursor-pointer text-xs px-2.5 py-1 rounded-md border border-border bg-accent hover:bg-accent/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Rebalance
            </button>
          </div>
        </div>

        <div>
          <div className="text-sm text-muted-foreground">USDC Balance</div>
          <div className="text-sm font-mono font-medium">{formatUsdc(vaultUsdcBalance)} USDC</div>
        </div>

        <div className="flex justify-between items-center">
          <span className="text-sm text-muted-foreground">Last Rebalance</span>
          <span className="text-xs text-muted-foreground">{formatTimestamp(lastRebalance)}</span>
        </div>
      </div>

      <div className="border-t border-border pt-4">
        <h3 className="text-sm font-medium mb-2">Withdraw USDC</h3>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type="number"
              min="0"
              step="0.01"
              value={withdrawAmount}
              onChange={(e) => setWithdrawAmount(e.target.value)}
              placeholder="0.00"
              className="w-full py-2 px-3 pr-16 rounded-md bg-accent border border-border text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-medium">
              USDC
            </span>
          </div>
          <button
            onClick={handleWithdraw}
            disabled={txPending || !withdrawAmount || parseFloat(withdrawAmount) <= 0}
            className="cursor-pointer py-2 px-4 rounded-md bg-destructive text-white font-medium text-sm hover:bg-destructive/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {txPending ? "..." : "Withdraw"}
          </button>
        </div>
      </div>

      {error && (
        <div className="text-sm text-destructive mt-3 p-2 bg-destructive/10 rounded">
          {error}
        </div>
      )}

      {lastTxSig && (
        <div className="mt-3 text-xs text-muted-foreground">
          Last tx:{" "}
          <a
            href={`https://explorer.solana.com/tx/${lastTxSig}`}
            target="_blank"
            rel="noopener noreferrer"
            className="cursor-pointer text-primary hover:underline font-mono"
          >
            {lastTxSig.slice(0, 16)}...
          </a>
        </div>
      )}
    </div>
  );
}
