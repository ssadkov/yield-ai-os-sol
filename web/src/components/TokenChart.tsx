"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { createChart, ColorType, IChartApi, ISeriesApi, AreaSeries, Time } from "lightweight-charts";
import { Maximize2, Minimize2, Loader2, TrendingUp, TrendingDown } from "lucide-react";

interface TokenChartProps {
  address: string;
  symbol: string;
  defaultType?: string;
}

export function TokenChart({ address, symbol, defaultType = "1H" }: TokenChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [priceData, setPriceData] = useState<{ time: Time; value: number }[]>([]);

  // Period settings
  const periods = [
    { label: "1D", type: "15m", days: 1 },
    { label: "7D", type: "1H", days: 7 },
    { label: "1M", type: "4H", days: 30 },
    { label: "3M", type: "1D", days: 90 },
  ];
  
  const [activePeriod, setActivePeriod] = useState(periods[2]); // Default 1M

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        const timeTo = Math.floor(Date.now() / 1000);
        const timeFrom = timeTo - activePeriod.days * 24 * 60 * 60;
        
        const res = await fetch(
          `/api/birdeye/history?address=${address}&type=${activePeriod.type}&time_from=${timeFrom}&time_to=${timeTo}`
        );
        const json = await res.json();
        
        if (json.success && json.data?.items) {
          const formatted = json.data.items.map((item: any) => ({
            time: item.unixTime as Time,
            value: item.value,
          })).sort((a: any, b: any) => (a.time as number) - (b.time as number));
          
          setPriceData(formatted);
        } else {
          setError(json.message || "Failed to load chart data");
        }
      } catch (err) {
        setError("Network error");
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [address, activePeriod]);

  useEffect(() => {
    if (!chartContainerRef.current || loading || error || priceData.length === 0) return;

    const handleResize = () => {
      if (chartRef.current && chartContainerRef.current) {
        chartRef.current.applyOptions({ 
          width: chartContainerRef.current.clientWidth,
          height: isFullscreen ? window.innerHeight - 120 : 300 
        });
      }
    };

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#94a3b8",
      },
      grid: {
        vertLines: { color: "rgba(148, 163, 184, 0.1)" },
        horzLines: { color: "rgba(148, 163, 184, 0.1)" },
      },
      width: chartContainerRef.current.clientWidth,
      height: isFullscreen ? window.innerHeight - 120 : 300,
      timeScale: {
        borderColor: "rgba(148, 163, 184, 0.2)",
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: "rgba(148, 163, 184, 0.2)",
      },
    });

    const series = chart.addSeries(AreaSeries, {
      lineColor: "#3b82f6",
      topColor: "rgba(59, 130, 246, 0.4)",
      bottomColor: "rgba(59, 130, 246, 0.0)",
      lineWidth: 2,
    });

    series.setData(priceData);
    chart.timeScale().fitContent();

    chartRef.current = chart;
    seriesRef.current = series;

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
    };
  }, [priceData, loading, error, isFullscreen]);

  const stats = useMemo(() => {
    if (priceData.length < 2) return null;
    const start = priceData[0].value;
    const end = priceData[priceData.length - 1].value;
    const diff = end - start;
    const percent = (diff / start) * 100;
    return {
      price: end,
      percent: percent.toFixed(2),
      isUp: percent >= 0,
    };
  }, [priceData]);

  const toggleFullscreen = () => {
    setIsFullscreen(!isFullscreen);
  };

  return (
    <div className={`
      ${isFullscreen ? "fixed inset-0 z-50 bg-background/95 backdrop-blur-md p-4 sm:p-8" : "w-full my-4"}
    `}>
      <div className={`
        relative rounded-2xl border border-border/60 bg-card/50 overflow-hidden shadow-xl glassmorphism
        ${isFullscreen ? "h-full flex flex-col" : ""}
      `}>
        {/* Header */}
        <div className="px-4 py-3 border-b border-border/40 flex items-center justify-between bg-accent/10">
          <div className="flex items-center gap-3">
            <div className="bg-primary/20 p-1.5 rounded-lg">
               <TrendingUp className="w-4 h-4 text-primary" />
            </div>
            <div>
              <div className="text-sm font-bold uppercase tracking-tight">{symbol} Price Chart</div>
              {stats && (
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs font-mono">${stats.price.toLocaleString()}</span>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full flex items-center gap-0.5 ${stats.isUp ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500"}`}>
                    {stats.isUp ? <TrendingUp className="w-2 h-2" /> : <TrendingDown className="w-2 h-2" />}
                    {stats.percent}%
                  </span>
                </div>
              )}
            </div>
          </div>
          
          <div className="flex items-center gap-2">
             <div className="flex bg-accent/20 rounded-lg p-0.5 mr-2">
                {periods.map((p) => (
                  <button
                    key={p.label}
                    onClick={() => setActivePeriod(p)}
                    className={`px-2 py-1 text-[10px] font-bold rounded-md transition-all ${activePeriod.label === p.label ? "bg-primary text-primary-foreground shadow-sm" : "hover:bg-accent/40 text-muted-foreground"}`}
                  >
                    {p.label}
                  </button>
                ))}
             </div>
             <button 
              onClick={toggleFullscreen}
              className="p-1.5 hover:bg-accent/40 rounded-lg transition-colors text-muted-foreground"
             >
               {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
             </button>
          </div>
        </div>

        {/* Chart Area */}
        <div className={`relative ${isFullscreen ? "flex-1" : "h-[300px]"}`}>
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-card/20 backdrop-blur-[2px] z-10">
              <Loader2 className="w-8 h-8 text-primary animate-spin" />
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center p-6 text-center z-10">
              <div className="text-destructive text-sm font-medium bg-destructive/10 px-4 py-2 rounded-xl border border-destructive/20">
                {error}
              </div>
            </div>
          )}
          {!loading && !error && priceData.length === 0 && (
             <div className="absolute inset-0 flex items-center justify-center p-6 text-center z-10">
              <div className="text-muted-foreground text-sm">No price data available for this period</div>
            </div>
          )}
          <div ref={chartContainerRef} className="w-full h-full" />
        </div>
        
        {isFullscreen && (
          <div className="px-6 py-4 border-t border-border/40 bg-accent/5 text-[10px] text-muted-foreground flex justify-between items-center">
            <span>Powered by Birdeye & TradingView</span>
            <button 
              onClick={toggleFullscreen}
              className="text-xs font-semibold text-primary hover:underline"
            >
              Close Fullscreen
            </button>
          </div>
        )}
      </div>
      
      {/* Background Overlay for Fullscreen */}
      {isFullscreen && (
        <div 
          className="fixed inset-0 -z-10 bg-background/40 cursor-pointer" 
          onClick={toggleFullscreen}
        />
      )}
    </div>
  );
}
