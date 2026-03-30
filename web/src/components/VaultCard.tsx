"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useVault } from "@/hooks/useVault";
import { useVaultAssets } from "@/hooks/useVaultAssets";
import { useVaultPnl } from "@/hooks/useVaultPnl";
import { useRebalance } from "@/hooks/useRebalance";
import { AssetRowItem, formatUsd, isUsdcMint } from "@/components/AssetRow";
import { deriveVaultPda, type StrategyName } from "@/lib/vault";

const COLLAPSED_COUNT = 7;

function orbExplorerUrl(vaultAddress: string): string {
  return `https://orbmarkets.io/address/${vaultAddress}/history?hideSpam=true`;
}

function formatTimestamp(ts: number): string {
  if (ts === 0) return "Never";
  return new Date(ts * 1000).toLocaleString();
}

const strategyHelp: Record<StrategyName, string> = {
  Conservative: "Lower risk. Target mix: 60% USDC / 40% USDY.",
  Balanced: "Medium risk. Target mix: 30% USDC / 30% USDY / 20% cbBTC / 20% SPYx.",
  Growth: "Higher risk. Target mix: 10% USDC / 20% USDY / 35% cbBTC / 35% SPYx.",
};

export function VaultCard() {
  const { publicKey } = useWallet();
  const { vault, strategyName, txPending, error, lastTxSig, refresh, loading } = useVault();
  const { rebalance, approveWhitelist, rebalancing, result: rebalanceResult, error: rebalanceError, needsWhitelist } = useRebalance();
  const [holdingsExpanded, setHoldingsExpanded] = useState(false);

  const vaultPda = publicKey && vault ? deriveVaultPda(publicKey)[0] : null;
  const vaultAddress = vaultPda?.toBase58() ?? "";
  const {
    assets: vaultAssets,
    totalUsd: vaultTotalUsd,
    loading: vaultAssetsLoading,
    refresh: refreshVaultAssets,
  } = useVaultAssets(vaultPda);

  const {
    data: pnlData,
    loading: pnlLoading,
    refresh: refreshPnl,
  } = useVaultPnl(vaultTotalUsd > 0 ? vaultTotalUsd : null);

  const handleRefreshAll = async () => {
    await Promise.all([refresh(), refreshVaultAssets(), refreshPnl()]);
  };

  const holdingsVisible = holdingsExpanded
    ? vaultAssets
    : vaultAssets.slice(0, COLLAPSED_COUNT);
  const holdingsHiddenCount = vaultAssets.length - COLLAPSED_COUNT;
  const holdingsHasMore = vaultAssets.length > COLLAPSED_COUNT;

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

  const lastRebalance = vault.lastRebalanceTs
    ? vault.lastRebalanceTs.toNumber()
    : 0;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-lg font-semibold shrink-0">Vault</h2>
          <a
            href={orbExplorerUrl(vaultAddress)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs p-1.5 rounded-md border border-border bg-muted/50 text-muted-foreground hover:text-foreground hover:border-muted-foreground/50 transition-colors shrink-0"
            title="View on explorer"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
              />
            </svg>
          </a>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs bg-success/20 text-success px-2 py-0.5 rounded font-medium">
            Active
          </span>
          <button
            type="button"
            onClick={handleRefreshAll}
            disabled={loading || vaultAssetsLoading}
            className="cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading || vaultAssetsLoading ? "..." : "Refresh"}
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
              onClick={rebalance}
              disabled={txPending || rebalancing}
              className="cursor-pointer text-xs px-2.5 py-1 rounded-md border border-border bg-accent hover:bg-accent/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {rebalancing ? "Rebalancing..." : "Rebalance"}
            </button>
          </div>
        </div>

        <div>
          <div className="text-sm font-medium mb-2">Holdings</div>
          {vaultAssets.length === 0 && !vaultAssetsLoading && (
            <p className="text-sm text-muted-foreground py-2">No token balances</p>
          )}
          {vaultAssetsLoading && vaultAssets.length === 0 && (
            <p className="text-sm text-muted-foreground py-2">Loading holdings...</p>
          )}
          <div className="divide-y divide-border -mx-1">
            {holdingsVisible.map((asset) => (
              <AssetRowItem
                key={asset.mint}
                asset={asset}
                highlighted={isUsdcMint(asset.mint)}
              />
            ))}
          </div>
          {holdingsHasMore && (
            <button
              type="button"
              onClick={() => setHoldingsExpanded(!holdingsExpanded)}
              className="w-full mt-2 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {holdingsExpanded
                ? "Show less"
                : `Show ${holdingsHiddenCount} more tokens`}
            </button>
          )}
          {vaultAssets.length > 0 && (
            <div className="mt-3 pt-3 border-t border-border space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium text-muted-foreground">
                  Total Value
                </span>
                <span className="text-lg font-bold">{formatUsd(vaultTotalUsd)}</span>
              </div>

              {pnlData && (
                <div className="space-y-1.5">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-muted-foreground">Net Deposited</span>
                    <span className="text-xs font-mono text-muted-foreground">
                      {formatUsd(pnlData.netDeposited)}
                    </span>
                  </div>
                  {pnlData.pnl !== null && (() => {
                    const negligible = Math.abs(pnlData.pnl) < 0.01;
                    const positive = pnlData.pnl > 0;
                    const colorClass = negligible
                      ? "text-muted-foreground"
                      : positive
                        ? "text-success"
                        : "text-destructive";
                    return (
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-muted-foreground">PnL</span>
                        <span className={`text-sm font-semibold ${colorClass}`}>
                          {negligible
                            ? "$0.00"
                            : `${positive ? "+" : ""}${formatUsd(pnlData.pnl)}`}
                          {!negligible && pnlData.pnlPercent !== null && (
                            <span className="text-xs ml-1 font-normal opacity-80">
                              ({pnlData.pnlPercent >= 0 ? "+" : ""}
                              {pnlData.pnlPercent.toFixed(2)}%)
                            </span>
                          )}
                        </span>
                      </div>
                    );
                  })()}
                </div>
              )}
              {pnlLoading && !pnlData && (
                <div className="text-xs text-muted-foreground">Loading PnL...</div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-between items-center">
          <span className="text-sm text-muted-foreground">Last Rebalance</span>
          <span className="text-xs text-muted-foreground">{formatTimestamp(lastRebalance)}</span>
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

      {needsWhitelist && (
        <div className="mt-3 p-3 bg-primary/10 border border-primary/30 rounded space-y-2">
          <div className="text-sm font-medium">One-time setup required</div>
          <div className="text-xs text-muted-foreground">
            Your vault needs to whitelist Jupiter swap programs before the agent
            can rebalance. This is a one-time on-chain transaction that you sign
            as the vault owner. After this, all rebalances are fully automatic.
          </div>
          <button
            onClick={approveWhitelist}
            disabled={rebalancing}
            className="cursor-pointer text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {rebalancing ? "Approving..." : "Approve & Rebalance"}
          </button>
        </div>
      )}

      {rebalanceError && (
        <div className="text-sm text-destructive mt-3 p-2 bg-destructive/10 rounded">
          Rebalance: {rebalanceError}
        </div>
      )}

      {rebalanceResult && rebalanceResult.status === "success" && (
        <div className="mt-3 p-2 bg-success/10 rounded space-y-1">
          <div className="text-sm text-success font-medium">Rebalance complete</div>
          {rebalanceResult.signatures?.map((sig) => (
            <div key={sig} className="text-xs text-muted-foreground">
              <a
                href={`https://explorer.solana.com/tx/${sig}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline font-mono"
              >
                {sig.slice(0, 16)}...
              </a>
            </div>
          ))}
        </div>
      )}

      {rebalanceResult && rebalanceResult.status === "no_rebalance_needed" && (
        <div className="mt-3 p-2 bg-muted rounded text-sm text-muted-foreground">
          Portfolio already balanced — no swaps needed.
        </div>
      )}
    </div>
  );
}
