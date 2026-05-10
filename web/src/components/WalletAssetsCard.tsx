"use client";

import { useMemo, useState } from "react";
import { useWalletAssets } from "@/hooks/useWalletAssets";
import { AssetRowItem, formatUsd } from "@/components/AssetRow";
import { VAULT_DEPOSIT_ASSETS } from "@/lib/vaultDepositAssets";

const COLLAPSED_COUNT = 7;

const VAULT_SUPPORTED_MINTS = new Set(VAULT_DEPOSIT_ASSETS.map((a) => a.mint));

export function WalletAssetsCard() {
  const { assets, totalUsd, loading, refresh } = useWalletAssets();
  const [expanded, setExpanded] = useState(false);

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
    <div className="rounded-lg border border-border bg-card p-4">
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
        Highlighted tokens are supported by your vault and can be deposited directly.
      </p>

      <div className="divide-y divide-border">
        {visible.map((asset) => (
          <AssetRowItem
            key={asset.mint}
            asset={asset}
            highlighted={VAULT_SUPPORTED_MINTS.has(asset.mint)}
          />
        ))}
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
    </div>
  );
}
