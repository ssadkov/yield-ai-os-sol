"use client";

import { useState } from "react";
import { useWalletAssets, type AssetRow } from "@/hooks/useWalletAssets";
import { USDC_MINT_STR } from "@/lib/constants";

const COLLAPSED_COUNT = 7;

function formatUsd(value: number | null): string {
  if (value === null) return "—";
  return "$" + value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatBalance(value: number, decimals: number): string {
  const maxFrac = Math.max(Math.min(decimals, 6), 2);
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: maxFrac });
}

function AssetRowItem({ asset, highlighted }: { asset: AssetRow; highlighted?: boolean }) {
  return (
    <div
      className={`flex items-center justify-between py-2.5 px-3 rounded-md ${
        highlighted
          ? "border border-primary/50 bg-primary/5 -mx-2"
          : ""
      }`}
    >
      <div className="flex items-center gap-3">
        {asset.logoURI ? (
          <img
            src={asset.logoURI}
            alt={asset.symbol}
            className="w-7 h-7 rounded-full bg-muted"
          />
        ) : (
          <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground">
            {asset.symbol.charAt(0)}
          </div>
        )}
        <div>
          <div className="text-sm font-medium">{asset.symbol}</div>
          <div className="text-xs text-muted-foreground truncate max-w-[120px]">{asset.name}</div>
        </div>
      </div>
      <div className="text-right">
        <div className="text-sm font-mono">{formatBalance(asset.balance, asset.decimals)}</div>
        <div className="text-xs text-muted-foreground">{formatUsd(asset.usdValue)}</div>
      </div>
    </div>
  );
}

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
            highlighted={asset.mint === USDC_MINT_STR}
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
          <span className="text-sm font-medium text-muted-foreground">Total Value</span>
          <span className="text-lg font-bold">{formatUsd(totalUsd)}</span>
        </div>
      )}
    </div>
  );
}
