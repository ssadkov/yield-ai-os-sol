"use client";

import { useMemo, useState } from "react";
import { ArrowDownToLine } from "lucide-react";
import { useWalletAssets } from "@/hooks/useWalletAssets";
import { AssetRowItem, formatUsd } from "@/components/AssetRow";
import { DropZone } from "@/components/DropZone";
import { useVault } from "@/hooks/useVault";
import { VAULT_DEPOSIT_ASSETS } from "@/lib/vaultDepositAssets";
import { formatWalletError } from "@/lib/walletError";
import type { DragAsset } from "@/lib/dragAsset";

const COLLAPSED_COUNT = 7;

const VAULT_SUPPORTED_MINTS = new Set(VAULT_DEPOSIT_ASSETS.map((a) => a.mint));

export function WalletAssetsCard() {
  const { assets, totalUsd, loading, refresh } = useWalletAssets();
  const { withdrawAsset } = useVault();
  const [expanded, setExpanded] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const [dropPending, setDropPending] = useState(false);

  const handleVaultDrop = async (asset: DragAsset) => {
    if (asset.source !== "vault") return;
    if (asset.balance <= 0) return;
    setDropError(null);
    setDropPending(true);
    try {
      await withdrawAsset({
        mint: asset.mint,
        decimals: asset.decimals,
        uiAmount: String(asset.balance),
      });
    } catch (err) {
      setDropError(formatWalletError(err));
    } finally {
      setDropPending(false);
    }
  };

  const sortedAssets = useMemo(() => {
    // Surface vault-supported assets first so the user sees what they can deposit.
    return [...assets].sort((a, b) => {
      const aSupported = VAULT_SUPPORTED_MINTS.has(a.mint) ? 1 : 0;
      const bSupported = VAULT_SUPPORTED_MINTS.has(b.mint) ? 1 : 0;
      if (aSupported !== bSupported) return bSupported - aSupported;
      return (b.usdValue ?? 0) - (a.usdValue ?? 0);
    });
  }, [assets]);

  const hasMore = sortedAssets.length > COLLAPSED_COUNT;
  const visible = expanded ? sortedAssets : sortedAssets.slice(0, COLLAPSED_COUNT);
  const hiddenCount = sortedAssets.length - COLLAPSED_COUNT;

  return (
    <DropZone
      className="rounded-lg border border-border bg-card p-4 relative transition-all"
      compatibleClassName="ring-2 ring-success/40 ring-offset-2 ring-offset-background"
      overClassName="ring-success bg-success/5 scale-[1.005]"
      incompatibleClassName="opacity-60"
      accept={(asset) => asset.source === "vault" && asset.balance > 0}
      onAssetDrop={handleVaultDrop}
      render={({ isCompatible, isOver, isDragActive }) => (
        <>
          {isDragActive && isCompatible && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg backdrop-blur-[1px] bg-success/5">
              <div
                className={`flex items-center gap-2 px-4 py-2 rounded-full bg-success/90 text-white text-sm font-semibold shadow-lg transition-transform ${
                  isOver ? "scale-110" : "scale-100"
                }`}
              >
                <ArrowDownToLine className="w-4 h-4" />
                {isOver ? "Release to withdraw" : "Drop here to withdraw"}
              </div>
            </div>
          )}
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold">Wallet Assets</h2>
        <button
          onClick={refresh}
          disabled={loading}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {assets.length === 0 && !loading && (
        <p className="text-sm text-muted-foreground py-4 text-center">
          Connect your wallet to view assets
        </p>
      )}

      <p className="text-[11px] text-muted-foreground mb-3">
        Drag a highlighted token onto the safe to deposit. Drag holdings from
        the safe back here to withdraw.
      </p>

      <div className="divide-y divide-border">
        {visible.map((asset) => {
          const isSupported = VAULT_SUPPORTED_MINTS.has(asset.mint);
          return (
            <AssetRowItem
              key={asset.mint}
              asset={asset}
              highlighted={isSupported}
              dragSource={isSupported ? "wallet" : undefined}
            />
          );
        })}
      </div>

      {hasMore && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full mt-2 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? "Show less" : `Show ${hiddenCount} more tokens`}
        </button>
      )}

      {assets.length > 0 && (
        <div className="flex justify-between items-center mt-3 pt-3 border-t border-border">
          <span className="text-sm font-medium text-muted-foreground">
            Total Value
          </span>
          <span className="text-lg font-bold">{formatUsd(totalUsd)}</span>
        </div>
      )}

      {dropPending && (
        <p className="mt-3 text-[11px] text-muted-foreground">
          Submitting withdrawal...
        </p>
      )}
      {dropError && (
        <p className="mt-3 text-[11px] text-destructive break-all">{dropError}</p>
      )}
        </>
      )}
    />
  );
}
