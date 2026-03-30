"use client";

import { useState } from "react";
import { useWalletAssets } from "@/hooks/useWalletAssets";
import { AssetRowItem, formatUsd, isUsdcMint } from "@/components/AssetRow";

const COLLAPSED_COUNT = 7;

export function WalletAssetsCard() {
  const { assets, totalUsd, loading, refresh } = useWalletAssets();
  const [expanded, setExpanded] = useState(false);

  const hasMore = assets.length > COLLAPSED_COUNT;
  const visible = expanded ? assets : assets.slice(0, COLLAPSED_COUNT);
  const hiddenCount = assets.length - COLLAPSED_COUNT;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
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

      <div className="divide-y divide-border">
        {visible.map((asset) => (
          <AssetRowItem
            key={asset.mint}
            asset={asset}
            highlighted={isUsdcMint(asset.mint)}
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
