"use client";

import { useState } from "react";
import { ShieldCheck, RefreshCw, TrendingUp, X, Check, Loader2, Heart } from "lucide-react";
import { useWallet } from "@solana/wallet-adapter-react";
import { TokenChart } from "@/components/TokenChart";
import { useVault } from "@/hooks/useVault";
import { useVaultAssets } from "@/hooks/useVaultAssets";
import { useKaminoKvaultPositions } from "@/hooks/useKaminoKvaultPositions";
import { useJupiterBorrowPositions } from "@/hooks/useJupiterBorrowPositions";
import { useVaultPnl } from "@/hooks/useVaultPnl";
import { useRebalance } from "@/hooks/useRebalance";
import { AssetRowItem, formatUsd, isUsdcMint } from "@/components/AssetRow";
import { VaultAllocationChart } from "@/components/VaultAllocationChart";
import { deriveVaultPda, getMissingDefaultAllowedPrograms, type StrategyName } from "@/lib/vault";
import { STRATEGY_DEFS, formatTargetMix } from "@/lib/strategies";
import { USDC_DECIMALS, USDC_MINT_STR } from "@/lib/constants";
import { VAULT_DEPOSIT_ASSETS } from "@/lib/vaultDepositAssets";
import { JUPITER_XSTOCKS_USDC_MARKETS } from "@/lib/jupiterBorrowMarkets";

const COLLAPSED_COUNT = 7;
const USDC_LOGO_URL =
  "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png";
const KAMINO_LOGO_URL = "https://cdn.kamino.finance/kamino.svg";
const JUPITER_LOGO_URL = "https://static.jup.ag/jup/icon.png";
const LOOP_TARGET_KVAULT = "91b1opzHNUQobfLZxGMNYT5qDRKoqV8FdsdQBmH4wBxy";
const LOOP_STEP_PAUSE_MS = 4000;
const sleepLoop = (ms: number) => new Promise((r) => setTimeout(r, ms));

type LoopStepStatus = "pending" | "running" | "done" | "error";
interface DeactStep {
  label: string;
  status: LoopStepStatus;
  signature?: string;
  error?: string;
}

function xStockLogoUrl(symbol: string): string {
  return `https://xstocks-metadata.backed.fi/logos/tokens/${symbol}.png`;
}

function orbExplorerUrl(vaultAddress: string): string {
  return `https://orbmarkets.io/address/${vaultAddress}/history?hideSpam=true`;
}

function ProtocolBadge({ src, alt }: { src: string; alt: string }) {
  return (
    <img
      src={src}
      alt={alt}
      className="w-4 h-4 rounded-full bg-muted border border-border"
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).style.display = "none";
      }}
    />
  );
}

function ChartTrigger({ mint, symbol }: { mint: string; symbol: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="cursor-pointer p-0.5 rounded-md text-muted-foreground hover:text-primary hover:bg-accent transition-colors"
        title={`Show ${symbol} chart`}
      >
        <TrendingUp className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="relative w-full max-w-2xl bg-card border border-border rounded-xl shadow-2xl overflow-hidden p-1">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="absolute top-4 right-4 z-50 p-2 hover:bg-accent rounded-full text-muted-foreground hover:text-foreground transition-all cursor-pointer bg-card/80 backdrop-blur-md border border-border/50"
            >
              <X className="w-5 h-5" />
            </button>
            <div className="p-2 sm:p-4">
              <TokenChart address={mint} symbol={symbol} />
            </div>
          </div>
          <div
            className="absolute inset-0 -z-10 cursor-pointer"
            onClick={() => setOpen(false)}
          />
        </div>
      )}
    </>
  );
}

function DualIcon({
  primarySrc,
  primaryAlt,
  badgeSrc,
  badgeAlt,
}: {
  primarySrc: string;
  primaryAlt: string;
  badgeSrc: string;
  badgeAlt: string;
}) {
  return (
    <div className="relative w-7 h-7 shrink-0">
      <img
        src={primarySrc}
        alt={primaryAlt}
        className="w-7 h-7 rounded-full bg-muted"
        onError={(e) => {
          const t = e.currentTarget as HTMLImageElement;
          t.replaceWith(
            Object.assign(document.createElement("div"), {
              className:
                "w-7 h-7 rounded-full bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground",
              textContent: primaryAlt.charAt(0),
            }),
          );
        }}
      />
      <img
        src={badgeSrc}
        alt={badgeAlt}
        className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-card ring-1 ring-border"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
    </div>
  );
}

function formatTimestamp(ts: number): string {
  if (ts === 0) return "Never";
  return new Date(ts * 1000).toLocaleString();
}

function formatTokenAmount(value: number | null): string {
  if (value === null) return "-";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

function formatApy(value: string | null): string | null {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return `${(n * 100).toFixed(2)}% APY`;
}

function formatPercent(value: number | null | undefined, label = "APY"): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return `${value.toFixed(2)}% ${label}`;
}

function formatSignedUsd(value: number): string {
  const abs = Math.abs(value);
  const formatted = formatUsd(abs);
  if (value < 0) return `-${formatted}`;
  if (value > 0) return `+${formatted}`;
  return formatted;
}

function apyDecimalToPercent(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n * 100 : null;
}

function decodeDisplayName(value: unknown): string {
  if (typeof value === "string") return value.replace(/\0+$/, "");
  if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
    return String.fromCharCode(...value).replace(/\0+$/, "");
  }
  return "Kamino kVault";
}

function usdcToRawAmount(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "0";
  const [whole, fractional = ""] = normalized.split(".");
  const paddedFractional = fractional.padEnd(USDC_DECIMALS, "0").slice(0, USDC_DECIMALS);
  return `${whole || "0"}${paddedFractional}`.replace(/^0+(?=\d)/, "") || "0";
}

function decimalToRawAmount(value: string, decimals: number): string {
  const normalized = value.trim();
  if (!normalized) return "0";
  const [whole, fractional = ""] = normalized.split(".");
  const paddedFractional = fractional.padEnd(decimals, "0").slice(0, decimals);
  return `${whole || "0"}${paddedFractional}`.replace(/^0+(?=\d)/, "") || "0";
}

function rawToDecimalAmount(raw: string, decimals: number): string {
  const digits = raw.padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? "" : digits.slice(-decimals).replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

function formatAmount(value: number): string {
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

const strategyHelp: Record<StrategyName, string> = {
  Conservative: `${STRATEGY_DEFS.Conservative.summary} Target mix: ${formatTargetMix(STRATEGY_DEFS.Conservative)}.`,
  Balanced: `${STRATEGY_DEFS.Balanced.summary} Target mix: ${formatTargetMix(STRATEGY_DEFS.Balanced)}.`,
  Aggressive: `${STRATEGY_DEFS.Aggressive.summary} Target mix: ${formatTargetMix(STRATEGY_DEFS.Aggressive)}.`,
};

export function VaultCard() {
  const { publicKey } = useWallet();
  const { vault, strategyName, txPending, error, lastTxSig, refresh, loading, updateAllowlist } = useVault();
  const {
    rebalance,
    convertAssetToUsdc,
    swapVaultAsset,
    depositJupiterBorrowCollateral,
    withdrawJupiterBorrowCollateral,
    borrowJupiterUsdc,
    repayJupiterUsdc,
    approveWhitelist,
    rebalancing,
    convertingMint,
    result: rebalanceResult,
    error: rebalanceError,
    needsWhitelist,
    lastActionLabel,
  } = useRebalance();
  const [holdingsExpanded, setHoldingsExpanded] = useState(false);
  const [kaminoWithdrawVault, setKaminoWithdrawVault] = useState<string | null>(null);
  const [kaminoWithdrawError, setKaminoWithdrawError] = useState<string | null>(null);
  const [buyTargetMint, setBuyTargetMint] = useState(VAULT_DEPOSIT_ASSETS.find((asset) => asset.symbol === "SPYx")?.mint ?? "");
  const [buyAmount, setBuyAmount] = useState("");
  const [lendTargetMint, setLendTargetMint] = useState(JUPITER_XSTOCKS_USDC_MARKETS[0]?.mint ?? "");
  const [lendAmount, setLendAmount] = useState("");
  const [borrowAmounts, setBorrowAmounts] = useState<Record<string, string>>({});
  const [repayAmounts, setRepayAmounts] = useState<Record<string, string>>({});
  const [repayMaxFlags, setRepayMaxFlags] = useState<Record<string, boolean>>({});
  const [deactSteps, setDeactSteps] = useState<DeactStep[] | null>(null);
  const [deactivating, setDeactivating] = useState(false);
  const [deactError, setDeactError] = useState<string | null>(null);

  const vaultPda = publicKey && vault ? deriveVaultPda(publicKey)[0] : null;
  const vaultAddress = vaultPda?.toBase58() ?? "";
  const {
    assets: vaultAssets,
    totalUsd: vaultTotalUsd,
    loading: vaultAssetsLoading,
    refresh: refreshVaultAssets,
  } = useVaultAssets(vaultPda);

  const {
    positions: kaminoPositions,
    loading: kaminoPositionsLoading,
    error: kaminoPositionsError,
    refresh: refreshKaminoPositions,
  } = useKaminoKvaultPositions(publicKey);
  const {
    positions: jupiterBorrowPositions,
    loading: jupiterBorrowPositionsLoading,
    error: jupiterBorrowPositionsError,
    refresh: refreshJupiterBorrowPositions,
  } = useJupiterBorrowPositions(publicKey);

  const handleRefreshAll = async () => {
    await Promise.all([
      refresh(),
      refreshVaultAssets(),
      refreshPnl(),
      refreshKaminoPositions(),
      refreshJupiterBorrowPositions(),
    ]);
  };

  const handleKaminoWithdraw = async (position: (typeof kaminoPositions)[number]) => {
    if (!publicKey) return;
    setKaminoWithdrawVault(position.vaultAddress);
    setKaminoWithdrawError(null);
    try {
      const res = await fetch("/api/kamino/kvault/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerPubkey: publicKey.toBase58(),
          kvault: position.vaultAddress,
          amount: position.totalShares,
        }),
      });
      const data = (await res.json()) as { status?: string; error?: string; missingPrograms?: string[] };
      if (!res.ok || data.status === "error") {
        throw new Error(data.error ?? `Kamino withdraw failed (${res.status})`);
      }
      if (data.status === "needs_whitelist") {
        throw new Error("Vault allowlist needs an update before Kamino withdraw can run.");
      }
      await handleRefreshAll();
      // Chain state typically propagates within a few seconds after the
      // server-side tx confirmation; re-refresh once so the UI catches up.
      window.setTimeout(() => {
        void handleRefreshAll();
      }, 3500);
    } catch (err: unknown) {
      setKaminoWithdrawError(err instanceof Error ? err.message : String(err));
    } finally {
      setKaminoWithdrawVault(null);
    }
  };

  const handleDeactivateLoop = async (
    jupiterLeg: (typeof jupiterBorrowPositions)[number],
    kaminoLeg: (typeof kaminoPositions)[number] | null,
  ) => {
    if (!publicKey || deactivating) return;
    setDeactivating(true);
    setDeactError(null);

    const ownerStr = publicKey.toBase58();
    const steps: DeactStep[] = [
      {
        label: kaminoLeg
          ? `Unstake ${formatTokenAmount(kaminoLeg.underlyingAmount)} USDC from Kamino`
          : "Skip Kamino unstake (no position)",
        status: kaminoLeg ? "pending" : "done",
      },
      {
        label: `Repay ${formatTokenAmount(jupiterLeg.debtAmount)} USDC (full debt)`,
        status: "pending",
      },
      {
        label: `Withdraw ${formatTokenAmount(jupiterLeg.collateralAmount)} ${jupiterLeg.collateralSymbol} collateral`,
        status: "pending",
      },
    ];
    setDeactSteps(steps);

    const update = (index: number, patch: Partial<DeactStep>) => {
      setDeactSteps((prev) => {
        if (!prev) return prev;
        const next = prev.slice();
        next[index] = { ...next[index], ...patch };
        return next;
      });
    };

    // Track which step is currently active so the catch always marks the right one.
    let currentStep = 0;
    try {
      // Step 1 — Kamino withdraw (skip if no kamino leg)
      if (kaminoLeg) {
        currentStep = 0;
        update(0, { status: "running" });
        const res = await fetch("/api/kamino/kvault/withdraw", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ownerPubkey: ownerStr,
            kvault: kaminoLeg.vaultAddress,
            amount: kaminoLeg.totalShares,
          }),
        });
        const data = (await res.json()) as { status?: string; error?: string; signatures?: string[] };
        if (!res.ok || data.status === "error") {
          throw new Error(`Kamino unstake: ${data.error ?? `HTTP ${res.status}`}`);
        }
        if (data.status === "needs_whitelist") {
          throw new Error("Kamino unstake needs an allowlist update first.");
        }
        update(0, { status: "done", signature: data.signatures?.[data.signatures.length - 1] });
        triggerBalanceRefresh();
        await sleepLoop(LOOP_STEP_PAUSE_MS);
      }

      // Step 2 — Jupiter repay (MAX)
      currentStep = 1;
      update(1, { status: "running" });
      const repayRes = await fetch("/api/jupiter/borrow/repay-usdc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerPubkey: ownerStr,
          vaultId: jupiterLeg.vaultId,
          positionId: jupiterLeg.positionId,
          amountRaw: "0",
          max: true,
        }),
      });
      const repayData = (await repayRes.json()) as { status?: string; error?: string; signatures?: string[] };
      if (!repayRes.ok || repayData.status === "error") {
        throw new Error(`Repay: ${repayData.error ?? `HTTP ${repayRes.status}`}`);
      }
      update(1, {
        status: "done",
        signature: repayData.signatures?.[repayData.signatures.length - 1],
      });
      triggerBalanceRefresh();
      await sleepLoop(LOOP_STEP_PAUSE_MS);

      // Step 3 — Jupiter withdraw collateral
      currentStep = 2;
      update(2, { status: "running" });
      const wRes = await fetch("/api/jupiter/borrow/withdraw-collateral", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerPubkey: ownerStr,
          vaultId: jupiterLeg.vaultId,
          positionId: jupiterLeg.positionId,
        }),
      });
      const wData = (await wRes.json()) as { status?: string; error?: string; signatures?: string[] };
      if (!wRes.ok || wData.status === "error") {
        throw new Error(`Withdraw collateral: ${wData.error ?? `HTTP ${wRes.status}`}`);
      }
      update(2, {
        status: "done",
        signature: wData.signatures?.[wData.signatures.length - 1],
      });
      triggerBalanceRefresh();
      for (const delay of [3000, 8000, 15000]) {
        window.setTimeout(() => triggerBalanceRefresh(), delay);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setDeactError(msg);
      // Mark the step that was active when the error happened, regardless
      // of whether its "running" state had committed in React.
      update(currentStep, { status: "error", error: msg });
    } finally {
      setDeactivating(false);
    }
  };

  const isHiddenPositionToken = (asset: (typeof vaultAssets)[number]) =>
    kaminoPositions.some((position) => position.sharesMint === asset.mint) ||
    asset.symbol.toLowerCase().startsWith("ki") ||
    asset.name.toLowerCase().startsWith("kamino ") ||
    asset.name.toLowerCase().startsWith("jupiter vault") ||
    /^jv\d+$/i.test(asset.symbol);

  const holdingsVisible = holdingsExpanded
    ? vaultAssets.filter((asset) => !isHiddenPositionToken(asset))
    : vaultAssets
        .filter((asset) => !isHiddenPositionToken(asset))
        .slice(0, COLLAPSED_COUNT);
  const visibleVaultAssets = vaultAssets.filter((asset) => !isHiddenPositionToken(asset));
  const visibleHoldingsUsd = visibleVaultAssets.reduce((sum, asset) => sum + (asset.usdValue ?? 0), 0);
  const directAnnualYieldUsd = visibleVaultAssets.reduce(
    (sum, asset) => sum + ((asset.usdValue ?? 0) * (asset.apr?.value ?? 0)) / 100,
    0,
  );
  const kaminoPositionsUsd = kaminoPositions.reduce((sum, position) => sum + (position.underlyingUsd ?? 0), 0);
  const kaminoAnnualYieldUsd = kaminoPositions.reduce((sum, position) => {
    const apyPercent = apyDecimalToPercent(position.apy);
    return sum + ((position.underlyingUsd ?? 0) * (apyPercent ?? 0)) / 100;
  }, 0);
  const jupiterCollateralUsd = jupiterBorrowPositions.reduce((sum, position) => sum + (position.collateralUsd ?? 0), 0);
  const jupiterDebtUsd = jupiterBorrowPositions.reduce((sum, position) => sum + (position.debtUsd ?? 0), 0);
  const jupiterNetUsd = jupiterBorrowPositions.reduce((sum, position) => sum + (position.netUsd ?? 0), 0);
  const jupiterAnnualYieldUsd = jupiterBorrowPositions.reduce((sum, position) => {
    const collateralYield = ((position.collateralUsd ?? 0) * (position.depositApy ?? 0)) / 100;
    const debtCost = ((position.debtUsd ?? 0) * (position.borrowAPY ?? 0)) / 100;
    return sum + collateralYield - debtCost;
  }, 0);
  const vaultNetUsd = visibleHoldingsUsd + kaminoPositionsUsd + jupiterNetUsd;
  const estimatedAnnualYieldUsd = directAnnualYieldUsd + kaminoAnnualYieldUsd + jupiterAnnualYieldUsd;
  const estimatedVaultApy = vaultNetUsd > 0 ? (estimatedAnnualYieldUsd / vaultNetUsd) * 100 : null;
  const pnlCurrentValueUsd =
    vaultAssetsLoading || kaminoPositionsLoading || jupiterBorrowPositionsLoading ? null : vaultNetUsd;
  const {
    data: pnlData,
    loading: pnlLoading,
    refresh: refreshPnl,
  } = useVaultPnl(pnlCurrentValueUsd);
  const holdingsHiddenCount = visibleVaultAssets.length - COLLAPSED_COUNT;
  const holdingsHasMore = visibleVaultAssets.length > COLLAPSED_COUNT;

  const chartAssets = [
    ...visibleVaultAssets,
    ...kaminoPositions
      .filter((p) => (p.underlyingUsd ?? 0) > 0.05)
      .map((p) => ({
        mint: `kamino:${p.vaultAddress}`,
        symbol: "Kamino USDC",
        name: p.vaultName,
        logoURI: USDC_LOGO_URL,
        balance: p.underlyingAmount ?? 0,
        rawAmount: "0",
        decimals: 6,
        usdPrice: 1,
        usdValue: p.underlyingUsd ?? 0,
        apr: apyDecimalToPercent(p.apy)
          ? { value: apyDecimalToPercent(p.apy) as number, source: "kamino" }
          : undefined,
      })),
    ...jupiterBorrowPositions
      .map((p) => {
        // Collateral USD price (e.g. SPYx) may not be in the Jupiter price
        // feed yet; fall back to debtUsd as a close proxy for collateral
        // size in a balanced borrow loop so the slice still renders.
        const usdValue = p.collateralUsd ?? p.debtUsd ?? 0;
        return {
          mint: `jupiter:${p.vaultId}:${p.positionId}`,
          symbol: `${p.collateralSymbol} (Jupiter)`,
          name: p.market,
          logoURI: xStockLogoUrl(p.collateralSymbol),
          balance: p.collateralAmount,
          rawAmount: "0",
          decimals: 0,
          usdPrice: null,
          usdValue,
          apr:
            p.depositApy != null
              ? { value: p.depositApy, source: "jupiter" }
              : undefined,
        };
      })
      .filter((row) => row.usdValue > 0.05),
  ];
  const chartTotalUsd = chartAssets.reduce((sum, a) => sum + (a.usdValue ?? 0), 0);
  const vaultUsdcAsset = vaultAssets.find((asset) => asset.mint === USDC_MINT_STR);
  const vaultUsdc = vaultUsdcAsset?.balance ?? 0;
  const buyTargets = VAULT_DEPOSIT_ASSETS.filter((asset) => asset.mint !== USDC_MINT_STR);
  const selectedBuyTarget = buyTargets.find((asset) => asset.mint === buyTargetMint) ?? buyTargets[0];
  const buyAmountNumber = Number(buyAmount);
  const buyAmountInvalid =
    !buyAmount ||
    !Number.isFinite(buyAmountNumber) ||
    buyAmountNumber <= 0 ||
    buyAmountNumber > vaultUsdc;
  const setBuyPercent = (pct: number) => {
    if (vaultUsdc <= 0) return;
    setBuyAmount(formatAmount(vaultUsdc * pct));
  };
  const handleBuyAsset = async () => {
    if (!selectedBuyTarget || buyAmountInvalid) return;
    await swapVaultAsset({
      inputMint: USDC_MINT_STR,
      outputMint: selectedBuyTarget.mint,
      amount: usdcToRawAmount(buyAmount),
      amountUsd: buyAmountNumber,
    });
    setBuyAmount("");
    await handleRefreshAll();
  };
  const availableJupiterLendMarkets = JUPITER_XSTOCKS_USDC_MARKETS.map((market) => ({
    market,
    asset: vaultAssets.find((asset) => asset.mint === market.mint),
  })).filter((item): item is { market: (typeof JUPITER_XSTOCKS_USDC_MARKETS)[number]; asset: NonNullable<typeof item.asset> } =>
    Boolean(item.asset && Number(item.asset.balance) > 0),
  );
  const selectedLendItem =
    availableJupiterLendMarkets.find((item) => item.market.mint === lendTargetMint) ??
    availableJupiterLendMarkets[0];
  const lendAmountNumber = Number(lendAmount);
  const lendAmountRaw =
    selectedLendItem && lendAmount && Number.isFinite(lendAmountNumber) && lendAmountNumber > 0
      ? decimalToRawAmount(lendAmount, selectedLendItem.market.decimals)
      : "0";
  const lendAmountInvalid =
    !selectedLendItem ||
    !lendAmount ||
    !Number.isFinite(lendAmountNumber) ||
    lendAmountNumber <= 0 ||
    BigInt(lendAmountRaw) > BigInt(selectedLendItem.asset.rawAmount);
  const setLendPercent = (pct: number) => {
    if (!selectedLendItem || BigInt(selectedLendItem.asset.rawAmount) === BigInt(0)) return;
    const raw = BigInt(selectedLendItem.asset.rawAmount);
    const maxRaw = raw > BigInt(1) ? raw - BigInt(1) : raw;
    const nextRaw = pct === 1 ? maxRaw : (raw * BigInt(Math.round(pct * 100))) / BigInt(100);
    setLendAmount(rawToDecimalAmount(nextRaw.toString(), selectedLendItem.market.decimals));
  };
  const handleJupiterLendDeposit = async () => {
    if (!selectedLendItem || lendAmountInvalid) return;
    await depositJupiterBorrowCollateral({
      vaultId: selectedLendItem.market.vaultId,
      amountRaw: lendAmountRaw,
    });
    setLendAmount("");
    await handleRefreshAll();
  };
  const handleJupiterLendWithdraw = async (position: (typeof jupiterBorrowPositions)[number]) => {
    if (BigInt(position.debtRaw) !== BigInt(0)) return;
    await withdrawJupiterBorrowCollateral({
      vaultId: position.vaultId,
      positionId: position.positionId,
    });
    await handleRefreshAll();
    window.setTimeout(() => void handleRefreshAll(), 3500);
  };
  const handleJupiterUsdcBorrow = async (position: (typeof jupiterBorrowPositions)[number]) => {
    const key = `${position.vaultId}:${position.positionId}`;
    const raw = usdcToRawAmount(borrowAmounts[key] ?? "");
    if (BigInt(raw) === BigInt(0)) return;
    await borrowJupiterUsdc({
      vaultId: position.vaultId,
      positionId: position.positionId,
      amountRaw: raw,
    });
    setBorrowAmounts((prev) => ({ ...prev, [key]: "" }));
    await handleRefreshAll();
    window.setTimeout(() => void handleRefreshAll(), 3500);
  };
  const handleJupiterUsdcRepay = async (position: (typeof jupiterBorrowPositions)[number]) => {
    const key = `${position.vaultId}:${position.positionId}`;
    const raw = usdcToRawAmount(repayAmounts[key] ?? "");
    const max = repayMaxFlags[key] === true;
    if (!max && BigInt(raw) === BigInt(0)) return;
    await repayJupiterUsdc({
      vaultId: position.vaultId,
      positionId: position.positionId,
      amountRaw: raw,
      max,
    });
    setRepayAmounts((prev) => ({ ...prev, [key]: "" }));
    setRepayMaxFlags((prev) => ({ ...prev, [key]: false }));
    await handleRefreshAll();
    window.setTimeout(() => void handleRefreshAll(), 3500);
  };

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
  const missingDefaultPrograms = getMissingDefaultAllowedPrograms(vault);
  const allowlistNeedsUpdate = missingDefaultPrograms.length > 0;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-lg font-semibold shrink-0 flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary" aria-hidden />
            AI Agent Safe
          </h2>
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
            title="Refresh"
            aria-label="Refresh"
            className="cursor-pointer p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${loading || vaultAssetsLoading ? "animate-spin" : ""}`}
            />
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
            {(() => {
              const hasActiveLoops =
                kaminoPositions.length > 0 || jupiterBorrowPositions.length > 0;
              return (
                <button
                  type="button"
                  onClick={rebalance}
                  disabled={txPending || rebalancing || hasActiveLoops}
                  title={
                    hasActiveLoops
                      ? "Unwind active Kamino / Jupiter Lend positions before strategy rebalance."
                      : "Rebalance vault holdings to match strategy target."
                  }
                  className="cursor-pointer text-xs px-2.5 py-1 rounded-md border border-border bg-accent hover:bg-accent/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {rebalancing ? "Rebalancing..." : "Rebalance"}
                </button>
              );
            })()}
          </div>
        </div>

        <VaultAllocationChart assets={chartAssets} totalUsd={chartTotalUsd} />

        {false && vaultUsdc > 0 && (
        <details className="rounded-md border border-border bg-accent/25 p-3 group">
          <summary className="cursor-pointer list-none flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs text-muted-foreground transition-transform group-open:rotate-90 shrink-0">▶</span>
              <div className="min-w-0">
                <div className="text-sm font-medium">Trade</div>
                <div className="text-[11px] text-muted-foreground">
                  Buy approved assets with vault USDC
                </div>
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-[11px] text-muted-foreground">Vault USDC</div>
              <div className="text-xs font-mono">{formatAmount(vaultUsdc)}</div>
            </div>
          </summary>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(150px,190px)_auto] gap-2">
            <select
              value={selectedBuyTarget?.mint ?? ""}
              onChange={(e) => setBuyTargetMint(e.target.value)}
              className="rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              {buyTargets.map((asset) => (
                <option key={asset.mint} value={asset.mint}>
                  {asset.symbol} - {asset.name}
                </option>
              ))}
            </select>
            <div className="relative">
              <input
                type="text"
                inputMode="decimal"
                min="0"
                value={buyAmount}
                onChange={(e) => {
                  const next = e.target.value.replace(",", ".");
                  if (/^\d*\.?\d*$/.test(next)) setBuyAmount(next);
                }}
                placeholder="USDC amount"
                className="w-full rounded-md border border-border bg-card px-3 py-2 pr-14 text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">
                USDC
              </span>
            </div>
            <button
              type="button"
              onClick={() => void handleBuyAsset()}
              disabled={rebalancing || buyAmountInvalid}
              className="cursor-pointer rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {rebalancing ? "Trading..." : "Buy"}
            </button>
          </div>
          <div className="mt-2 flex gap-1">
            {[0.25, 0.5, 1].map((pct) => (
              <button
                key={pct}
                type="button"
                onClick={() => setBuyPercent(pct)}
                disabled={rebalancing || vaultUsdc <= 0}
                className="cursor-pointer text-[11px] px-2 py-0.5 rounded border border-border bg-card text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {pct === 1 ? "MAX" : `${Math.round(pct * 100)}%`}
              </button>
            ))}
          </div>
        </details>
        )}

        {false && availableJupiterLendMarkets.length > 0 && (
          <div className="rounded-md border border-border bg-accent/25 p-3">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <div className="text-sm font-medium">Jupiter Lend collateral</div>
                <div className="text-[11px] text-muted-foreground">
                  Deposit xStocks from vault for later USDC borrow
                </div>
              </div>
              {selectedLendItem && (
                <div className="text-right">
                  <div className="text-[11px] text-muted-foreground">Available</div>
                  <div className="text-xs font-mono">
                    {formatAmount(selectedLendItem.asset.balance)} {selectedLendItem.market.symbol}
                  </div>
                </div>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(150px,190px)_auto] gap-2">
              <select
                value={selectedLendItem?.market.mint ?? ""}
                onChange={(e) => {
                  setLendTargetMint(e.target.value);
                  setLendAmount("");
                }}
                className="rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                {availableJupiterLendMarkets.map(({ market, asset }) => (
                  <option key={market.mint} value={market.mint}>
                    {market.symbol} / USDC - {formatAmount(asset.balance)}
                  </option>
                ))}
              </select>
              <div className="relative">
                <input
                  type="text"
                  inputMode="decimal"
                  min="0"
                  value={lendAmount}
                  onChange={(e) => {
                    const next = e.target.value.replace(",", ".");
                    if (/^\d*\.?\d*$/.test(next)) setLendAmount(next);
                  }}
                  placeholder="Amount"
                  className="w-full rounded-md border border-border bg-card px-3 py-2 pr-16 text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">
                  {selectedLendItem?.market.symbol ?? ""}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void handleJupiterLendDeposit()}
                disabled={rebalancing || lendAmountInvalid}
                className="cursor-pointer rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {rebalancing ? "Depositing..." : "Deposit"}
              </button>
            </div>
            <div className="mt-2 flex gap-1">
              {[0.25, 0.5, 1].map((pct) => (
                <button
                  key={pct}
                  type="button"
                  onClick={() => setLendPercent(pct)}
                  disabled={rebalancing || !selectedLendItem}
                  className="cursor-pointer text-[11px] px-2 py-0.5 rounded border border-border bg-card text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {pct === 1 ? "MAX" : `${Math.round(pct * 100)}%`}
                </button>
              ))}
            </div>
          </div>
        )}

        {(() => {
          // Active loop = any Jupiter Lend xStock position with non-zero collateral
          // or debt. We pair it with the user's Kamino Private Credit USDC position
          // (the loop target) for the synthesized view.
          const activeJupiterLeg = jupiterBorrowPositions.find(
            (p) => (p.collateralUsd ?? 0) > 0.01 || (p.debtUsd ?? 0) > 0.01,
          );
          if (!activeJupiterLeg) return null;
          const kaminoLeg =
            kaminoPositions.find(
              (p) => p.vaultAddress === LOOP_TARGET_KVAULT && (p.underlyingUsd ?? 0) > 0.01,
            ) ?? null;

          const colUsd = activeJupiterLeg.collateralUsd ?? 0;
          const debtUsd = activeJupiterLeg.debtUsd ?? 0;
          const kamUsd = kaminoLeg?.underlyingUsd ?? 0;
          const netUsd = colUsd - debtUsd + kamUsd;
          const colYield = (colUsd * (activeJupiterLeg.depositApy ?? 0)) / 100;
          const borrowCost = (debtUsd * (activeJupiterLeg.borrowAPY ?? 0)) / 100;
          const kamApy = kaminoLeg ? apyDecimalToPercent(kaminoLeg.apy) ?? 0 : 0;
          const kamYield = (kamUsd * kamApy) / 100;
          const annualYieldUsd = colYield + kamYield - borrowCost;
          const netApy = netUsd > 0.01 ? (annualYieldUsd / netUsd) * 100 : null;
          const health = debtUsd > 0.01 ? colUsd / debtUsd : null;

          let healthLabel = "—";
          let healthCls = "text-muted-foreground";
          if (health !== null) {
            healthLabel = health.toFixed(2);
            healthCls =
              health >= 2 ? "text-success" : health >= 1.5 ? "text-foreground" : "text-destructive";
          }

          return (
            <div className="rounded-md border border-primary/40 bg-gradient-to-br from-primary/10 via-primary/5 to-card p-3 mb-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <DualIcon
                    primarySrc={xStockLogoUrl(activeJupiterLeg.collateralSymbol)}
                    primaryAlt={activeJupiterLeg.collateralSymbol}
                    badgeSrc={JUPITER_LOGO_URL}
                    badgeAlt="Jupiter"
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold flex items-center gap-2 flex-wrap">
                      <span>{activeJupiterLeg.collateralSymbol} Earn Loop</span>
                      <span className="text-[10px] uppercase tracking-wide bg-success/15 text-success px-1.5 py-0.5 rounded font-mono">
                        Active
                      </span>
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      Lend → Borrow USDC → Stake in Kamino
                    </div>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  {netApy !== null && (
                    <div
                      className={`text-base font-bold leading-tight ${
                        netApy >= 0 ? "text-success" : "text-destructive"
                      }`}
                    >
                      {netApy >= 0 ? "+" : ""}
                      {netApy.toFixed(2)}% Net
                    </div>
                  )}
                  <div className={`text-[11px] font-mono flex items-center justify-end gap-1 ${healthCls}`}>
                    <Heart className="w-3 h-3" />
                    Health {healthLabel}
                  </div>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                <div className="rounded bg-card/60 border border-border p-2">
                  <div className="text-muted-foreground">Collateral</div>
                  <div className="font-mono text-foreground">
                    {formatTokenAmount(activeJupiterLeg.collateralAmount)} {activeJupiterLeg.collateralSymbol}
                  </div>
                  <div className="text-muted-foreground">{formatUsd(activeJupiterLeg.collateralUsd)}</div>
                </div>
                <div className="rounded bg-card/60 border border-border p-2">
                  <div className="text-muted-foreground">Earning in Kamino</div>
                  <div className="font-mono text-foreground">
                    {kaminoLeg ? `${formatTokenAmount(kaminoLeg.underlyingAmount)} USDC` : "—"}
                  </div>
                  <div className="text-muted-foreground">
                    {kaminoLeg ? `${kamApy.toFixed(2)}% APY · ${formatUsd(kaminoLeg.underlyingUsd)}` : "—"}
                  </div>
                </div>
              </div>

              <div
                className="mt-2 text-[10px] text-muted-foreground"
                title="Demo-only watcher — auto-deleverage planner is wired but not running yet."
              >
                Agent will auto-deleverage if Health falls below 1.5
              </div>

              {!deactSteps && (
                <button
                  type="button"
                  onClick={() => void handleDeactivateLoop(activeJupiterLeg, kaminoLeg)}
                  disabled={deactivating}
                  className="mt-3 cursor-pointer w-full inline-flex items-center justify-center rounded-md border border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20 py-1.5 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Deactivate loop
                </button>
              )}

              {deactSteps && deactError && (
                <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive break-all">
                  {deactError}
                </div>
              )}
              {deactSteps && (
                <div className="mt-3 space-y-1.5">
                  {deactSteps.map((step, i) => (
                    <div key={i} className="flex items-start gap-2 text-[11px]">
                      <span className="shrink-0 mt-0.5">
                        {step.status === "done" && <Check className="w-3.5 h-3.5 text-success" />}
                        {step.status === "running" && <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />}
                        {step.status === "error" && <X className="w-3.5 h-3.5 text-destructive" />}
                        {step.status === "pending" && (
                          <span className="block w-3.5 h-3.5 rounded-full border border-muted-foreground/40" />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div
                          className={
                            step.status === "done"
                              ? "text-success"
                              : step.status === "running"
                                ? "text-foreground"
                                : step.status === "error"
                                  ? "text-destructive"
                                  : "text-muted-foreground"
                          }
                        >
                          {step.label}
                        </div>
                        {step.signature && (
                          <a
                            href={`https://solscan.io/tx/${step.signature}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] text-muted-foreground hover:text-primary font-mono"
                          >
                            {step.signature.slice(0, 8)}…{step.signature.slice(-8)}
                          </a>
                        )}
                        {step.error && (
                          <div className="text-[10px] text-destructive break-all">{step.error}</div>
                        )}
                      </div>
                    </div>
                  ))}
                  {deactError && deactSteps.every((s) => s.status !== "running") && (
                    <div className="mt-2 flex gap-3 items-center">
                      <button
                        type="button"
                        onClick={() => {
                          setDeactSteps(null);
                          setDeactError(null);
                        }}
                        className="text-[10px] text-muted-foreground hover:text-foreground underline"
                      >
                        Dismiss
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setDeactSteps(null);
                          setDeactError(null);
                          void handleDeactivateLoop(activeJupiterLeg, kaminoLeg);
                        }}
                        className="text-[10px] text-primary hover:underline"
                      >
                        Retry from current state
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })()}

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
                onConvertToUsdc={convertAssetToUsdc}
                converting={convertingMint === asset.mint}
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
          {(kaminoPositions.length > 0 || kaminoPositionsLoading || kaminoPositionsError) && (
            <div className="mt-3 rounded-md border border-border bg-accent/25 p-3">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="text-sm font-medium flex items-center gap-2">
                  <ProtocolBadge src={KAMINO_LOGO_URL} alt="Kamino" />
                  Kamino Earn
                </div>
                {kaminoPositionsLoading && (
                  <span className="text-[11px] text-muted-foreground">Loading...</span>
                )}
              </div>
              <div className="divide-y divide-border">
                {kaminoPositions.map((position) => {
                  const apyPercent = apyDecimalToPercent(position.apy);
                  const isWithdrawing = kaminoWithdrawVault === position.vaultAddress;
                  return (
                    <div
                      key={position.vaultAddress}
                      className="flex items-center justify-between py-2.5 px-1 gap-3"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <DualIcon
                          primarySrc={USDC_LOGO_URL}
                          primaryAlt="USDC"
                          badgeSrc={KAMINO_LOGO_URL}
                          badgeAlt="Kamino"
                        />
                        <div className="min-w-0">
                          <div className="text-sm font-medium flex items-center gap-2">
                            <span>USDC</span>
                            {apyPercent !== null && (
                              <span
                                className="text-[10px] bg-success/15 text-success px-1.5 py-0.5 rounded font-mono"
                                title="Source: Kamino"
                              >
                                {apyPercent.toFixed(2)}% APY
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-muted-foreground truncate max-w-[180px]">
                            {decodeDisplayName(position.vaultName)}
                          </div>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-mono">
                          {formatTokenAmount(position.underlyingAmount)}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {formatUsd(position.underlyingUsd)}
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleKaminoWithdraw(position)}
                          disabled={kaminoWithdrawVault !== null}
                          className="mt-1 cursor-pointer text-[10px] px-2 py-0.5 rounded border border-border bg-card text-muted-foreground hover:text-foreground hover:border-muted-foreground/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {isWithdrawing ? "Withdrawing..." : "Withdraw"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              {kaminoWithdrawError && (
                <div className="mt-2 text-xs text-destructive">{kaminoWithdrawError}</div>
              )}
              {kaminoPositionsError && (
                <div className="mt-2 text-xs text-destructive">{kaminoPositionsError}</div>
              )}
            </div>
          )}
          {(jupiterBorrowPositions.length > 0 || jupiterBorrowPositionsLoading || jupiterBorrowPositionsError) && (
            <div className="mt-3 rounded-md border border-border bg-accent/25 p-3">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="text-sm font-medium flex items-center gap-2">
                  <ProtocolBadge src={JUPITER_LOGO_URL} alt="Jupiter" />
                  Jupiter Lend
                </div>
                {jupiterBorrowPositionsLoading && (
                  <span className="text-[11px] text-muted-foreground">Loading...</span>
                )}
              </div>
              <div className="divide-y divide-border">
                {jupiterBorrowPositions.map((position) => {
                  const hasDebt = BigInt(position.debtRaw) !== BigInt(0);
                  return (
                  <div key={`${position.vaultId}:${position.positionId}`} className="py-2.5 px-1 space-y-2">
                    {/* Collateral row */}
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <DualIcon
                          primarySrc={xStockLogoUrl(position.collateralSymbol)}
                          primaryAlt={position.collateralSymbol}
                          badgeSrc={JUPITER_LOGO_URL}
                          badgeAlt="Jupiter"
                        />
                        <div className="min-w-0">
                          <div className="text-sm font-medium flex items-center gap-2 flex-wrap">
                            <span>{position.collateralSymbol}</span>
                            <ChartTrigger
                              mint={position.collateralMint}
                              symbol={position.collateralSymbol}
                            />
                            {position.depositApy != null && (
                              <span
                                className="text-[10px] bg-success/15 text-success px-1.5 py-0.5 rounded font-mono"
                                title="Supply APY paid by Jupiter on this collateral"
                              >
                                {position.depositApy.toFixed(2)}% supply
                              </span>
                            )}
                            {position.netApy !== null && (
                              <span
                                className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                                  position.netApy >= 0
                                    ? "bg-success/15 text-success"
                                    : "bg-destructive/15 text-destructive"
                                }`}
                                title="Net APY = collateral yield − debt cost"
                              >
                                Net {position.netApy.toFixed(2)}%
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-muted-foreground truncate">
                            Collateral · Position #{position.positionId}
                          </div>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-mono">
                          {formatTokenAmount(position.collateralAmount)} {position.collateralSymbol}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {formatUsd(position.collateralUsd)}
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleJupiterLendWithdraw(position)}
                          disabled={rebalancing || hasDebt}
                          title={
                            hasDebt
                              ? "Repay debt before withdrawing collateral"
                              : "Withdraw collateral back to vault"
                          }
                          className="mt-1 cursor-pointer text-[10px] px-2 py-0.5 rounded border border-border bg-card text-muted-foreground hover:text-foreground hover:border-muted-foreground/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {rebalancing ? "Withdrawing..." : "Withdraw"}
                        </button>
                      </div>
                    </div>

                    {/* Borrow row */}
                    {hasDebt && (
                      <div className="flex items-center justify-between gap-3 rounded-md bg-destructive/5 border border-destructive/20 px-2 py-1.5">
                        <div className="flex items-center gap-3 min-w-0">
                          <DualIcon
                            primarySrc={USDC_LOGO_URL}
                            primaryAlt="USDC"
                            badgeSrc={JUPITER_LOGO_URL}
                            badgeAlt="Jupiter"
                          />
                          <div className="min-w-0">
                            <div className="text-sm font-medium flex items-center gap-2 flex-wrap">
                              <span>USDC</span>
                              {position.borrowAPY != null && (
                                <span
                                  className="text-[10px] bg-destructive/15 text-destructive px-1.5 py-0.5 rounded font-mono"
                                  title="Borrow APR charged on this debt"
                                >
                                  {position.borrowAPY.toFixed(2)}% borrow
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-muted-foreground truncate">
                              Borrowed against {position.collateralSymbol}
                            </div>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-sm font-mono">
                            {formatTokenAmount(position.debtAmount)} {position.borrowSymbol}
                          </div>
                          {position.debtUsd !== null && (
                            <div className="text-[11px] text-muted-foreground">
                              {formatUsd(position.debtUsd)}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                      <div className="relative">
                        <input
                          type="text"
                          inputMode="decimal"
                          value={borrowAmounts[`${position.vaultId}:${position.positionId}`] ?? ""}
                          onChange={(e) => {
                            const next = e.target.value.replace(",", ".");
                            if (/^\d*\.?\d*$/.test(next)) {
                              setBorrowAmounts((prev) => ({
                                ...prev,
                                [`${position.vaultId}:${position.positionId}`]: next,
                              }));
                            }
                          }}
                          placeholder="Borrow USDC"
                          className="w-full rounded-md border border-border bg-card px-3 py-2 pr-12 text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/50"
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">
                          USDC
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleJupiterUsdcBorrow(position)}
                        disabled={
                          rebalancing ||
                          BigInt(usdcToRawAmount(borrowAmounts[`${position.vaultId}:${position.positionId}`] ?? "")) === BigInt(0)
                        }
                        className="cursor-pointer rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {rebalancing ? "Borrowing..." : "Borrow"}
                      </button>
                    </div>
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                      <div className="relative">
                        <input
                          type="text"
                          inputMode="decimal"
                          value={repayAmounts[`${position.vaultId}:${position.positionId}`] ?? ""}
                          onChange={(e) => {
                            const key = `${position.vaultId}:${position.positionId}`;
                            const next = e.target.value.replace(",", ".");
                            if (/^\d*\.?\d*$/.test(next)) {
                              setRepayAmounts((prev) => ({ ...prev, [key]: next }));
                              // Manual edit clears any prior MAX intent so a
                              // typed-in amount is treated as an exact value.
                              setRepayMaxFlags((prev) => ({ ...prev, [key]: false }));
                            }
                          }}
                          placeholder="Repay USDC"
                          className="w-full rounded-md border border-border bg-card px-3 py-2 pr-20 text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/50"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const key = `${position.vaultId}:${position.positionId}`;
                            const repayMax = Math.min(vaultUsdc, position.debtAmount);
                            setRepayAmounts((prev) => ({
                              ...prev,
                              [key]: formatAmount(repayMax),
                            }));
                            // Use the SDK's MAX_REPAY_AMOUNT sentinel server-side
                            // so we don't hit VAULT_USER_DEBT_TOO_LOW when the
                            // on-chain debt has accrued a few raw units since
                            // the UI last refreshed.
                            setRepayMaxFlags((prev) => ({ ...prev, [key]: true }));
                          }}
                          disabled={vaultUsdc <= 0 || position.debtAmount <= 0}
                          className="absolute right-12 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          MAX
                        </button>
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">
                          USDC
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleJupiterUsdcRepay(position)}
                        disabled={
                          rebalancing ||
                          BigInt(position.debtRaw) === BigInt(0) ||
                          (!repayMaxFlags[`${position.vaultId}:${position.positionId}`] &&
                            BigInt(usdcToRawAmount(repayAmounts[`${position.vaultId}:${position.positionId}`] ?? "")) === BigInt(0))
                        }
                        className="cursor-pointer rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {rebalancing ? "Repaying..." : "Repay"}
                      </button>
                    </div>
                  </div>
                  );
                })}
              </div>
              {jupiterBorrowPositionsError && (
                <div className="mt-2 text-xs text-destructive">{jupiterBorrowPositionsError}</div>
              )}
            </div>
          )}
          {!vaultAssetsLoading && (
            <div className="mt-3 pt-3 border-t border-border space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium text-muted-foreground">
                  Total Value
                </span>
                <span className="text-lg font-bold">{formatUsd(vaultNetUsd)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted-foreground">Est. Vault APY</span>
                <span
                  className={`text-sm font-semibold ${
                    estimatedVaultApy !== null && estimatedVaultApy < 0
                      ? "text-destructive"
                      : "text-success"
                  }`}
                >
                  {formatPercent(estimatedVaultApy) ?? "вЂ”"}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted-foreground">Est. Annual Yield</span>
                <span
                  className={`text-xs font-mono ${
                    estimatedAnnualYieldUsd < 0 ? "text-destructive" : "text-muted-foreground"
                  }`}
                >
                  {formatSignedUsd(estimatedAnnualYieldUsd)}
                </span>
              </div>
              {jupiterCollateralUsd > 0 && (
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">Jupiter Collateral</span>
                  <span className="text-xs font-mono text-muted-foreground">
                    {formatUsd(jupiterCollateralUsd)}
                  </span>
                </div>
              )}
              {jupiterDebtUsd > 0 && (
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">Borrow Debt</span>
                  <span className="text-xs font-mono text-destructive">
                    -{formatUsd(jupiterDebtUsd)}
                  </span>
                </div>
              )}
              {kaminoPositionsUsd > 0 && (
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">Kamino Earn</span>
                  <span className="text-xs font-mono text-muted-foreground">
                    {formatUsd(kaminoPositionsUsd)}
                  </span>
                </div>
              )}

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

        <div className="flex justify-between items-center mt-4 pt-4 border-t border-border">
          <span className="text-sm text-muted-foreground">Last Rebalance</span>
          <span className="text-xs text-muted-foreground">{formatTimestamp(lastRebalance)}</span>
        </div>
      </div>

      {allowlistNeedsUpdate && (
        <div className="mt-3 p-3 bg-primary/10 border border-primary/30 rounded space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">Protocol access update</div>
              <div className="text-xs text-muted-foreground">
                Your vault is missing {missingDefaultPrograms.length} program
                {missingDefaultPrograms.length === 1 ? "" : "s"} required for current swap and lending actions.
              </div>
            </div>
            <button
              type="button"
              onClick={updateAllowlist}
              disabled={txPending}
              className="cursor-pointer shrink-0 text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {txPending ? "Updating..." : "Update"}
            </button>
          </div>
        </div>
      )}

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
            Your vault needs to whitelist programs required by this route before
            the agent can execute it. This is a one-time on-chain transaction
            that you sign as the vault owner.
          </div>
          <button
            onClick={approveWhitelist}
            disabled={rebalancing}
            className="cursor-pointer text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {rebalancing ? "Approving..." : "Approve & Retry"}
          </button>
        </div>
      )}

      {rebalanceError && (
        <div className="text-sm text-destructive mt-3 p-2 bg-destructive/10 rounded">
          {lastActionLabel}: {rebalanceError}
        </div>
      )}

      {rebalanceResult && rebalanceResult.status === "success" && (
        <div className="mt-3 p-2 bg-success/10 rounded space-y-1">
          <div className="text-sm text-success font-medium">{lastActionLabel} complete</div>
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
          Portfolio already balanced вЂ” no swaps needed.
        </div>
      )}
    </div>
  );
}
