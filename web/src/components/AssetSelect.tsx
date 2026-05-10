"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { formatUsd } from "@/components/AssetRow";

export interface AssetSelectItem {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: number;
  logoURI?: string;
  usdValue?: number | null;
}

function Icon({ src, symbol }: { src?: string; symbol: string }) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return (
      <img
        src={src}
        alt={symbol}
        className="w-6 h-6 rounded-full bg-muted shrink-0"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold text-muted-foreground shrink-0">
      {symbol.charAt(0)}
    </div>
  );
}

function formatBalance(value: number, decimals: number): string {
  const maxFrac = Math.max(Math.min(decimals, 6), 2);
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: maxFrac,
  });
}

interface AssetSelectProps {
  items: AssetSelectItem[];
  selectedMint: string;
  onChange: (mint: string) => void;
  disabled?: boolean;
  emptyLabel?: string;
}

export function AssetSelect({
  items,
  selectedMint,
  onChange,
  disabled,
  emptyLabel = "No assets",
}: AssetSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const selected = items.find((i) => i.mint === selectedMint) ?? items[0];
  const isEmpty = items.length === 0;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled || isEmpty}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 rounded-lg border border-border bg-accent px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
      >
        {isEmpty || !selected ? (
          <span className="text-muted-foreground">{emptyLabel}</span>
        ) : (
          <>
            <Icon src={selected.logoURI} symbol={selected.symbol} />
            <div className="flex-1 min-w-0 text-left">
              <div className="font-medium truncate">{selected.symbol}</div>
              <div className="text-[11px] text-muted-foreground truncate">
                {selected.name}
              </div>
            </div>
            <div className="text-right">
              <div className="text-sm font-mono">
                {formatBalance(selected.balance, selected.decimals)}
              </div>
              {selected.usdValue != null && (
                <div className="text-[11px] text-muted-foreground">
                  {formatUsd(selected.usdValue)}
                </div>
              )}
            </div>
          </>
        )}
        <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
      </button>

      {open && !isEmpty && (
        <div className="absolute z-30 mt-1 w-full rounded-lg border border-border bg-card shadow-lg max-h-72 overflow-y-auto">
          {items.map((item) => {
            const isActive = item.mint === selectedMint;
            return (
              <button
                key={item.mint}
                type="button"
                onClick={() => {
                  onChange(item.mint);
                  setOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-accent transition-colors ${
                  isActive ? "bg-accent/60" : ""
                }`}
              >
                <Icon src={item.logoURI} symbol={item.symbol} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{item.symbol}</div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {item.name}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-mono">
                    {formatBalance(item.balance, item.decimals)}
                  </div>
                  {item.usdValue != null && (
                    <div className="text-[11px] text-muted-foreground">
                      {formatUsd(item.usdValue)}
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
