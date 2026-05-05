"use client";

import { useState } from "react";
import type { AssetRow as AssetRowType } from "@/lib/portfolioAssets";
import { SOL_MINT, USDC_MINT_STR } from "@/lib/constants";
import { ArrowRightLeft, Loader2, TrendingUp, X } from "lucide-react";
import { TokenChart } from "./TokenChart";

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
  onConvertToUsdc,
  converting,
}: {
  asset: AssetRowType;
  highlighted?: boolean;
  onConvertToUsdc?: (asset: AssetRowType) => void | Promise<void>;
  converting?: boolean;
}) {
  const [showChart, setShowChart] = useState(false);
  const canConvert =
    asset.mint !== SOL_MINT && !isUsdcMint(asset.mint) && Boolean(onConvertToUsdc);

  return (
    <>
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
        <div className="text-xs flex items-center justify-end gap-1.5 mt-0.5">
          <span className="text-muted-foreground">{formatUsd(asset.usdValue)}</span>
          {asset.priceChange24h != null && (
            <span
              className={
                asset.priceChange24h >= 0
                  ? "text-success text-[10px]"
                  : "text-destructive text-[10px]"
              }
            >
              {asset.priceChange24h > 0 ? "+" : ""}
              {asset.priceChange24h.toFixed(2)}%
            </span>
          )}
          
          {canConvert && (
            <button
              type="button"
              onClick={() => onConvertToUsdc?.(asset)}
              disabled={converting}
              className="inline-flex items-center gap-1 px-1.5 py-1 rounded-md border border-border bg-background text-[10px] font-medium text-muted-foreground hover:text-foreground hover:border-muted-foreground/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ml-1"
              title="Convert this holding to USDC"
            >
              {converting ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <ArrowRightLeft className="w-3 h-3" />
              )}
              USDC
            </button>
          )}

          {!isUsdcMint(asset.mint) && (
            <button
              onClick={() => setShowChart(true)}
              className="p-1 hover:bg-accent rounded-md text-muted-foreground hover:text-primary transition-colors cursor-pointer ml-1"
              title="Show Chart"
            >
              <TrendingUp className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>

      {/* Basic Modal Implementation */}
      {showChart && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
           <div className="relative w-full max-w-2xl bg-card border border-border rounded-xl shadow-2xl overflow-hidden p-1">
              <button 
                onClick={() => setShowChart(false)}
                className="absolute top-4 right-4 z-50 p-2 hover:bg-accent rounded-full text-muted-foreground hover:text-foreground transition-all cursor-pointer bg-card/80 backdrop-blur-md border border-border/50"
              >
                <X className="w-5 h-5" />
              </button>
              
              <div className="p-2 sm:p-4">
                <TokenChart 
                  address={asset.mint} 
                  symbol={asset.symbol} 
                />
              </div>
              
              <div className="px-6 pb-4 flex justify-end">
                <button 
                  onClick={() => setShowChart(false)}
                  className="text-sm font-semibold text-muted-foreground hover:text-foreground hover:underline transition-all cursor-pointer"
                >
                  Close
                </button>
              </div>
           </div>
           
           {/* Background click to close */}
           <div 
             className="absolute inset-0 -z-10 cursor-pointer" 
             onClick={() => setShowChart(false)}
           />
        </div>
      )}
    </>
  );
}

export function isUsdcMint(mint: string): boolean {
  return mint === USDC_MINT_STR;
}
