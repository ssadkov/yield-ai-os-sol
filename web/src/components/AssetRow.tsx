"use client";

import { useState } from "react";
import type { AssetRow as AssetRowType } from "@/lib/portfolioAssets";
import { USDC_MINT_STR } from "@/lib/constants";

function TokenIcon({ src, symbol }: { src?: string; symbol: string }) {
  const [failed, setFailed] = useState(false);

  if (src && !failed) {
    return (
      <img
        src={src}
        alt={symbol}
        className="w-7 h-7 rounded-full bg-muted"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground">
      {symbol.charAt(0)}
    </div>
  );
}

export function formatUsd(value: number | null): string {
  if (value === null) return "—";
  return (
    "$" +
    value.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

export function formatBalance(value: number, decimals: number): string {
  const maxFrac = Math.max(Math.min(decimals, 6), 2);
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: maxFrac,
  });
}

export function AssetRowItem({
  asset,
  highlighted,
}: {
  asset: AssetRowType;
  highlighted?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between py-2.5 px-3 rounded-md ${
        highlighted ? "border border-primary/50 bg-primary/5 -mx-2" : ""
      }`}
    >
      <div className="flex items-center gap-3">
        <TokenIcon src={asset.logoURI} symbol={asset.symbol} />
        <div>
          <div className="text-sm font-medium flex items-center gap-2">
            {asset.symbol}
            {asset.apr && (
              <span
                className="text-[10px] bg-success/15 text-success px-1.5 py-0.5 rounded font-mono"
                title={`Source: ${asset.apr.source}`}
              >
                {asset.apr.value.toFixed(2)}% APY
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground truncate max-w-[120px]">
            {asset.name}
          </div>
        </div>
      </div>
      <div className="text-right">
        <div className="text-sm font-mono">
          {formatBalance(asset.balance, asset.decimals)}
        </div>
        <div className="text-xs text-muted-foreground">
          {formatUsd(asset.usdValue)}
        </div>
      </div>
    </div>
  );
}

export function isUsdcMint(mint: string): boolean {
  return mint === USDC_MINT_STR;
}
