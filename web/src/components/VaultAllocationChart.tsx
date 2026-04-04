"use client";

import { useMemo } from "react";
import type { AssetRow } from "@/hooks/useVaultAssets";

interface VaultAllocationChartProps {
  assets: AssetRow[];
  totalUsd: number;
}

const COLORS = [
  "#3b82f6", // blue-500
  "#10b981", // emerald-500
  "#f59e0b", // amber-500
  "#8b5cf6", // violet-500
  "#ec4899", // pink-500
  "#06b6d4", // cyan-500
  "#f43f5e", // rose-500
  "#eab308", // yellow-500
];

export function VaultAllocationChart({ assets, totalUsd }: VaultAllocationChartProps) {
  // Filter out tiny dust amounts (< $0.05) and sort by USD value
  const validAssets = useMemo(() => {
    return assets
      .filter((a) => (a.usdValue ?? 0) > 0.05)
      .sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0));
  }, [assets]);

  // If no assets > $0.05, don't show the chart
  if (validAssets.length === 0 || totalUsd <= 0.05) {
    return null;
  }

  // Calculate SVG arc strokes
  const radius = 60;
  const circumference = 2 * Math.PI * radius;
  let currentOffset = 0;

  const slices = validAssets.map((asset, index) => {
    const value = asset.usdValue ?? 0;
    const percentage = value / totalUsd;
    const strokeLength = percentage * circumference;
    const strokeDasharray = `${strokeLength} ${circumference - strokeLength}`;
    
    // We start at top (-90 deg), and move around.
    const slice = {
      ...asset,
      color: COLORS[index % COLORS.length],
      strokeDasharray,
      strokeDashoffset: -currentOffset,
      percentage: percentage * 100,
    };
    
    currentOffset += strokeLength;
    return slice;
  });

  return (
    <div className="mt-4 pt-4 border-t border-border">
      <div className="text-sm font-medium mb-4">Allocation</div>
      
      <div className="flex flex-col sm:flex-row items-center gap-6">
        {/* The Donut Chart */}
        <div className="relative w-36 h-36 flex-shrink-0">
          <svg className="w-full h-full transform -rotate-90" viewBox="0 0 160 160">
            {slices.map((slice) => (
              <circle
                key={slice.symbol}
                cx="80"
                cy="80"
                r={radius}
                fill="transparent"
                stroke={slice.color}
                strokeWidth="24"
                strokeLinecap={slices.length === 1 ? "round" : "butt"}
                strokeDasharray={slice.strokeDasharray}
                strokeDashoffset={slice.strokeDashoffset}
                className="transition-all duration-1000 ease-out hover:stroke-[28px] cursor-pointer"
                style={{ transformOrigin: "center" }}
              />
            ))}
          </svg>

          {/* Absolute center label */}
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
              Assets
            </span>
            <span className="text-sm font-semibold">{slices.length}</span>
          </div>
        </div>

        {/* Legend */}
        <div className="flex-1 w-full grid grid-cols-2 gap-x-2 gap-y-3">
          {slices.map((slice) => (
            <div key={slice.symbol} className="flex items-center gap-2 group">
              <div 
                className="w-3 h-3 rounded-full flex-shrink-0" 
                style={{ backgroundColor: slice.color }} 
              />
              <div className="flex flex-col min-w-0">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-xs font-semibold truncate uppercase">
                    {slice.symbol}
                  </span>
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                    {slice.percentage.toFixed(1)}%
                  </span>
                </div>
                <span className="text-[10px] text-muted-foreground truncate">
                  ${(slice.usdValue ?? 0).toFixed(2)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
