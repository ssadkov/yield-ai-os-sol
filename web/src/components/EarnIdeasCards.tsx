"use client";

import { useEffect, useMemo, useState } from "react";
import { ShieldCheck, Sparkles, Check, Loader2, X as XIcon } from "lucide-react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { deriveVaultPda } from "@/lib/vault";
import { useVault } from "@/hooks/useVault";
import { useVaultAssets } from "@/hooks/useVaultAssets";
import { useWalletAssets } from "@/hooks/useWalletAssets";
import { EARN_IDEAS, EARN_IDEA_SYMBOLS, type EarnIdea } from "@/lib/earnIdeas";
import { triggerBalanceRefresh } from "@/lib/refreshEvent";
import { formatWalletError } from "@/lib/walletError";
import { USDC_MINT_STR, SOL_MINT } from "@/lib/constants";

type StepStatus = "pending" | "running" | "done" | "error";
interface LoopStep {
  label: string;
  status: StepStatus;
  signature?: string;
  error?: string;
}

const STEP_PAUSE_MS = 4000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface EarnIdeasResponse {
  success?: boolean;
  ideas?: EarnIdea[];
  fallback?: boolean;
  fetchedAtMs?: number;
}

interface ActionResponse {
  status?: "success" | "needs_whitelist" | "no_rebalance_needed" | "error";
  signatures?: string[];
  missingPrograms?: string[];
  error?: string;
}

const KAMINO_LOGO_URL = "https://cdn.kamino.finance/kamino.svg";
const JUPITER_LOGO_URL = "https://static.jup.ag/jup/icon.png";
const USDC_LOGO_URL =
  "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png";
const SOL_LOGO_URL =
  "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png";

const XSTOCK_SYMBOLS = new Set([
  "SPYx",
  "QQQx",
  "NVDAx",
  "TSLAx",
  "AAPLx",
  "GOOGLx",
  "MSTRx",
]);

function protocolLogo(protocol: string): { src: string; alt: string } | null {
  if (protocol === "Kamino") return { src: KAMINO_LOGO_URL, alt: "Kamino" };
  if (protocol === "Jupiter") return { src: JUPITER_LOGO_URL, alt: "Jupiter" };
  return null;
}

function mintLogoUrl(mint: string): string | undefined {
  if (mint === USDC_MINT_STR) return USDC_LOGO_URL;
  if (mint === SOL_MINT) return SOL_LOGO_URL;
  const symbol = EARN_IDEA_SYMBOLS[mint];
  if (symbol && XSTOCK_SYMBOLS.has(symbol)) {
    return `https://xstocks-metadata.backed.fi/logos/tokens/${symbol}.png`;
  }
  return undefined;
}

function ProtocolLogo({ protocol, size = 7 }: { protocol: string; size?: 5 | 7 }) {
  const logo = protocolLogo(protocol);
  const [failed, setFailed] = useState(false);
  const cls =
    size === 5
      ? "w-5 h-5 rounded-md bg-card ring-1 ring-border p-0.5"
      : "w-7 h-7 rounded-md bg-card ring-1 ring-border p-1";
  const fallbackCls =
    size === 5
      ? "w-5 h-5 rounded-md bg-muted ring-1 ring-border flex items-center justify-center text-[9px] font-bold text-muted-foreground"
      : "w-7 h-7 rounded-md bg-muted ring-1 ring-border flex items-center justify-center text-[10px] font-bold text-muted-foreground";
  if (!logo || failed) {
    return <div className={fallbackCls}>{protocol.charAt(0)}</div>;
  }
  return (
    <img src={logo.src} alt={logo.alt} className={cls} onError={() => setFailed(true)} />
  );
}

function HeroAsset({
  mint,
  protocol,
}: {
  mint: string;
  protocol: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = mintLogoUrl(mint);
  const symbol = EARN_IDEA_SYMBOLS[mint] ?? mint.slice(0, 4);
  const protoLogo = protocolLogo(protocol);
  return (
    <div className="relative w-10 h-10 shrink-0">
      {src && !failed ? (
        <img
          src={src}
          alt={symbol}
          className="w-10 h-10 rounded-full bg-muted ring-1 ring-border"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="w-10 h-10 rounded-full bg-muted ring-1 ring-border flex items-center justify-center text-sm font-bold text-muted-foreground">
          {symbol.charAt(0)}
        </div>
      )}
      {protoLogo && (
        <img
          src={protoLogo.src}
          alt={protoLogo.alt}
          className="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-md bg-card ring-1 ring-border p-0.5"
          onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
        />
      )}
    </div>
  );
}

function formatRelativeTime(ms?: number): string | null {
  if (!ms) return null;
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatBalance(n: number): string {
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

interface OwnedMatch {
  mint: string;
  symbol: string;
  balance: number;
  location: "wallet" | "vault";
}

export function EarnIdeasCards() {
  const { publicKey } = useWallet();
  const { setVisible: setWalletModalVisible } = useWalletModal();
  const { vault, updateAllowlist } = useVault();
  const vaultPda = publicKey && vault ? deriveVaultPda(publicKey)[0] : null;
  const { assets: vaultAssets } = useVaultAssets(vaultPda);
  const { assets: walletAssets } = useWalletAssets();
  const [ideas, setIdeas] = useState<EarnIdea[]>(EARN_IDEAS);
  const [sourceState, setSourceState] = useState<"loading" | "live" | "fallback">("loading");
  const [fetchedAtMs, setFetchedAtMs] = useState<number | null>(null);
  const [pendingIdeaId, setPendingIdeaId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loopSteps, setLoopSteps] = useState<Record<string, LoopStep[]>>({});

  useEffect(() => {
    let cancelled = false;
    async function loadIdeas() {
      try {
        const res = await fetch("/api/earn-ideas");
        const data = (await res.json()) as EarnIdeasResponse;
        if (cancelled) return;
        if (data.ideas?.length) {
          setIdeas(data.ideas);
          setSourceState(data.fallback ? "fallback" : "live");
          if (data.fetchedAtMs) setFetchedAtMs(data.fetchedAtMs);
        } else {
          setSourceState("fallback");
        }
      } catch {
        if (!cancelled) setSourceState("fallback");
      }
    }
    void loadIdeas();
    return () => {
      cancelled = true;
    };
  }, []);

  const ownedByMint = useMemo(() => {
    const out = new Map<string, OwnedMatch>();
    for (const asset of walletAssets) {
      if (asset.balance > 0) {
        out.set(asset.mint, {
          mint: asset.mint,
          symbol: asset.symbol,
          balance: asset.balance,
          location: "wallet",
        });
      }
    }
    for (const asset of vaultAssets) {
      if (asset.balance > 0) {
        // Vault holding takes precedence — it's actionable for one-click deposits.
        out.set(asset.mint, {
          mint: asset.mint,
          symbol: asset.symbol,
          balance: asset.balance,
          location: "vault",
        });
      }
    }
    return out;
  }, [walletAssets, vaultAssets]);

  const matchOwnedForIdea = (idea: EarnIdea): OwnedMatch | null => {
    for (const mint of idea.requiredMints) {
      const match = ownedByMint.get(mint);
      if (match) return match;
    }
    return null;
  };

  const ready: { idea: EarnIdea; match: OwnedMatch }[] = [];
  const discover: EarnIdea[] = [];
  for (const idea of ideas) {
    const match = matchOwnedForIdea(idea);
    if (match) ready.push({ idea, match });
    else discover.push(idea);
  }

  const postKaminoDeposit = async (idea: EarnIdea): Promise<ActionResponse> => {
    if (!publicKey) throw new Error("Wallet not connected");
    const ideaAction = idea.action;
    if (!ideaAction || ideaAction.type !== "kaminoKvaultDeposit") {
      throw new Error("This idea is not executable yet");
    }
    const holding = vaultAssets.find((asset) => asset.mint === ideaAction.tokenMint);
    if (!holding || BigInt(holding.rawAmount) === BigInt(0)) {
      throw new Error(`No ${EARN_IDEA_SYMBOLS[ideaAction.tokenMint] ?? "token"} in vault`);
    }
    const res = await fetch("/api/kamino/kvault/deposit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ownerPubkey: publicKey.toBase58(),
        kvault: ideaAction.kvault,
        amountRaw: holding.rawAmount,
        decimals: holding.decimals,
      }),
    });
    return (await res.json()) as ActionResponse;
  };

  const updateStep = (
    ideaId: string,
    index: number,
    patch: Partial<LoopStep>,
  ) => {
    setLoopSteps((prev) => {
      const arr = prev[ideaId];
      if (!arr) return prev;
      const next = arr.slice();
      next[index] = { ...next[index], ...patch };
      return { ...prev, [ideaId]: next };
    });
  };

  const runLoopActivation = async (idea: EarnIdea) => {
    if (!publicKey) throw new Error("Wallet not connected");
    if (idea.action?.type !== "stocksEarnLoop") throw new Error("Not a loop strategy");
    const loopAction = idea.action;

    const collateral = vaultAssets.find((asset) => asset.mint === loopAction.collateralMint);
    if (!collateral || collateral.balance <= 0) {
      throw new Error(`No ${loopAction.collateralSymbol} in safe. Move it from your wallet first.`);
    }
    const collateralRaw = collateral.rawAmount;
    const usdPrice = collateral.usdPrice;
    if (usdPrice == null || usdPrice <= 0) {
      throw new Error(`No live price for ${loopAction.collateralSymbol}; cannot size the borrow leg`);
    }
    const collateralUsd = collateral.balance * usdPrice;
    // 49% rather than 50% to leave a buffer against LTV rounding.
    const borrowUsd = collateralUsd * (loopAction.ltvPct - 1) / 100;
    const borrowRaw = Math.floor(borrowUsd * 10 ** loopAction.kvaultTokenDecimals);
    if (borrowRaw <= 0) throw new Error("Computed borrow amount is zero");
    const borrowRawStr = String(borrowRaw);
    const borrowUi = borrowRaw / 10 ** loopAction.kvaultTokenDecimals;

    const steps: LoopStep[] = [
      { label: `Lend ${collateral.balance.toFixed(6)} ${loopAction.collateralSymbol} as collateral`, status: "pending" },
      { label: `Borrow ${borrowUi.toFixed(4)} USDC (≈${loopAction.ltvPct - 1}% LTV)`, status: "pending" },
      { label: `Stake ${borrowUi.toFixed(4)} USDC into Kamino USDC vault`, status: "pending" },
    ];
    setLoopSteps((prev) => ({ ...prev, [idea.id]: steps }));

    const ownerStr = publicKey.toBase58();

    // Step 1: lend collateral
    updateStep(idea.id, 0, { status: "running" });
    try {
      const res = await fetch("/api/jupiter/borrow/deposit-collateral", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerPubkey: ownerStr,
          vaultId: loopAction.collateralVaultId,
          amountRaw: collateralRaw,
        }),
      });
      const data = (await res.json()) as ActionResponse;
      if (data.status !== "success") {
        throw new Error(data.error ?? `Jupiter Lend deposit failed: ${data.status ?? "unknown"}`);
      }
      updateStep(idea.id, 0, {
        status: "done",
        signature: data.signatures?.[data.signatures.length - 1],
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      updateStep(idea.id, 0, { status: "error", error: msg });
      throw err;
    }
    triggerBalanceRefresh();
    await sleep(STEP_PAUSE_MS);

    // Step 2: borrow USDC against the new collateral
    updateStep(idea.id, 1, { status: "running" });
    try {
      const res = await fetch("/api/jupiter/borrow/borrow-usdc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerPubkey: ownerStr,
          vaultId: loopAction.collateralVaultId,
          amountRaw: borrowRawStr,
        }),
      });
      const data = (await res.json()) as ActionResponse;
      if (data.status !== "success") {
        throw new Error(data.error ?? `Jupiter Lend borrow failed: ${data.status ?? "unknown"}`);
      }
      updateStep(idea.id, 1, {
        status: "done",
        signature: data.signatures?.[data.signatures.length - 1],
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      updateStep(idea.id, 1, { status: "error", error: msg });
      throw err;
    }
    triggerBalanceRefresh();
    await sleep(STEP_PAUSE_MS);

    // Step 3: stake the freshly-borrowed USDC into Kamino
    updateStep(idea.id, 2, { status: "running" });
    try {
      const res = await fetch("/api/kamino/kvault/deposit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerPubkey: ownerStr,
          kvault: loopAction.kvault,
          amountRaw: borrowRawStr,
          decimals: loopAction.kvaultTokenDecimals,
        }),
      });
      const data = (await res.json()) as ActionResponse;
      if (data.status === "needs_whitelist") {
        await updateAllowlist();
        const retry = await fetch("/api/kamino/kvault/deposit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ownerPubkey: ownerStr,
            kvault: loopAction.kvault,
            amountRaw: borrowRawStr,
            decimals: loopAction.kvaultTokenDecimals,
          }),
        });
        const retryData = (await retry.json()) as ActionResponse;
        if (retryData.status !== "success") {
          throw new Error(retryData.error ?? "Kamino deposit failed after allowlist update");
        }
        updateStep(idea.id, 2, {
          status: "done",
          signature: retryData.signatures?.[retryData.signatures.length - 1],
        });
      } else if (data.status !== "success") {
        throw new Error(data.error ?? `Kamino deposit failed: ${data.status ?? "unknown"}`);
      } else {
        updateStep(idea.id, 2, {
          status: "done",
          signature: data.signatures?.[data.signatures.length - 1],
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      updateStep(idea.id, 2, { status: "error", error: msg });
      throw err;
    }
    triggerBalanceRefresh();
  };

  const handleActivateLoop = async (idea: EarnIdea) => {
    if (pendingIdeaId) return;
    setPendingIdeaId(idea.id);
    setActionMessage(null);
    setActionError(null);
    try {
      await runLoopActivation(idea);
      setActionMessage(`${idea.action && idea.action.type === "stocksEarnLoop" ? idea.action.collateralSymbol : ""} loop activated.`);
      // Kamino's position endpoint typically takes a few seconds to reflect a
      // fresh deposit even with revalidate=0 — re-pulse refresh a few times.
      for (const delay of [3000, 8000, 15000]) {
        window.setTimeout(() => triggerBalanceRefresh(), delay);
      }
    } catch (err: unknown) {
      setActionError(formatWalletError(err));
    } finally {
      setPendingIdeaId(null);
    }
  };

  const handleKaminoDeposit = async (idea: EarnIdea) => {
    setPendingIdeaId(idea.id);
    setActionMessage(null);
    setActionError(null);
    try {
      let data = await postKaminoDeposit(idea);
      if (data.status === "needs_whitelist") {
        setActionMessage("Allowlist update required. Confirm the wallet transaction, then deposit will retry.");
        await updateAllowlist();
        data = await postKaminoDeposit(idea);
      }
      if (data.status !== "success") {
        throw new Error(data.error ?? `Kamino deposit failed: ${data.status ?? "unknown"}`);
      }
      triggerBalanceRefresh();
      const sig = data.signatures?.[data.signatures.length - 1];
      setActionMessage(sig ? `Kamino deposit sent: ${sig.slice(0, 8)}...${sig.slice(-8)}` : "Kamino deposit sent.");
    } catch (err: unknown) {
      setActionError(formatWalletError(err));
    } finally {
      setPendingIdeaId(null);
    }
  };

  function renderIdeaCard(idea: EarnIdea, match: OwnedMatch | null) {
    const isReady = match !== null;
    const inVault = match?.location === "vault";
    const isLoop = idea.action?.type === "stocksEarnLoop";
    const isKvault = idea.action?.type === "kaminoKvaultDeposit";
    const canActivateKvault = isReady && inVault && isKvault;
    const canActivateLoop = isReady && inVault && isLoop;
    const showMoveToVault =
      isReady && !inVault && (isKvault || isLoop);
    const steps = loopSteps[idea.id];
    const isActivatingThis = pendingIdeaId === idea.id;

    // Pick hero asset: the one the user holds (Ready), else the first
    // required mint as canonical representative for the idea.
    const heroMint = match?.mint ?? idea.requiredMints[0];
    const extras = idea.requiredMints.length - 1;
    const hasSpread = !!idea.spreadLabel;

    return (
      <article
        key={idea.id}
        className={`rounded-md border p-3 transition-colors ${
          isReady
            ? "border-primary/50 bg-primary/10"
            : "border-border bg-accent/30"
        }`}
      >
        <div className="flex items-start gap-3">
          <HeroAsset mint={heroMint} protocol={idea.protocol} />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold truncate">{idea.title}</h3>
                <div className="text-[11px] text-muted-foreground">
                  {idea.protocol}
                  {extras > 0 ? ` · +${extras} more option${extras > 1 ? "s" : ""}` : ""}
                </div>
              </div>
              <div className="text-right shrink-0">
                {hasSpread ? (
                  <>
                    <div className="text-sm font-semibold text-primary leading-tight">
                      {idea.spreadLabel}
                    </div>
                    <div className="text-[11px] text-success">{idea.apyLabel}</div>
                  </>
                ) : (
                  <div className="text-sm font-semibold text-success leading-tight">
                    {idea.apyLabel}
                  </div>
                )}
              </div>
            </div>

            {isReady ? (
              <div className="mt-1.5 text-[11px] text-success font-medium">
                {formatBalance(match.balance)} {match.symbol} in{" "}
                {match.location === "vault" ? "safe" : "wallet"}
              </div>
            ) : idea.borrowLabel ? (
              <div className="mt-1.5 text-[11px] text-muted-foreground">
                {idea.borrowLabel}
              </div>
            ) : null}

            {canActivateKvault && (
              <button
                type="button"
                disabled={pendingIdeaId !== null}
                onClick={() => void handleKaminoDeposit(idea)}
                className="mt-2 inline-flex h-7 items-center rounded-md bg-primary text-primary-foreground px-3 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isActivatingThis ? "Activating..." : "Activate"}
              </button>
            )}
            {canActivateLoop && !steps && (
              <button
                type="button"
                disabled={pendingIdeaId !== null}
                onClick={() => void handleActivateLoop(idea)}
                className="mt-2 inline-flex h-7 items-center rounded-md bg-primary text-primary-foreground px-3 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
              >
                Activate loop
              </button>
            )}
            {showMoveToVault && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                You need {match?.symbol ?? idea.requiredMints[0]} in your safe — move it from your wallet first.
              </p>
            )}
            {!isReady && (idea.action?.type === "stocksEarnLoop") && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                You need {idea.action.collateralSymbol} in your safe to activate this loop.
              </p>
            )}

            {steps && (
              <div className="mt-3 space-y-1.5">
                {steps.map((step, i) => (
                  <div key={i} className="flex items-start gap-2 text-[11px]">
                    <span className="shrink-0 mt-0.5">
                      {step.status === "done" && <Check className="w-3.5 h-3.5 text-success" />}
                      {step.status === "running" && <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />}
                      {step.status === "error" && <XIcon className="w-3.5 h-3.5 text-destructive" />}
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
              </div>
            )}
          </div>
        </div>
      </article>
    );
  }

  // --- Wallet not connected — single CTA card ---
  if (!publicKey) {
    const top3 = [...ideas]
      .sort((a, b) => parseFloat(b.apyLabel) - parseFloat(a.apyLabel))
      .slice(0, 3);
    return (
      <section className="rounded-lg border border-primary/30 bg-gradient-to-br from-primary/15 via-card to-card p-5">
        <div className="flex items-center gap-2 mb-3">
          <ShieldCheck className="w-5 h-5 text-primary" />
          <h2 className="text-base font-semibold">Connect wallet to earn</h2>
        </div>
        <ul className="space-y-2 mb-4">
          {top3.map((idea) => {
            const logo = protocolLogo(idea.protocol);
            return (
              <li key={idea.id} className="flex items-center gap-2 text-sm">
                {logo ? (
                  <img
                    src={logo.src}
                    alt={logo.alt}
                    className="w-5 h-5 rounded-md bg-card ring-1 ring-border p-0.5"
                  />
                ) : (
                  <Sparkles className="w-4 h-4 text-primary" />
                )}
                <span className="flex-1 truncate text-muted-foreground">{idea.title}</span>
                <span className="text-success font-mono text-xs">{idea.apyLabel}</span>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          onClick={() => setWalletModalVisible(true)}
          className="cursor-pointer w-full inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground py-2 px-4 text-sm font-semibold hover:bg-primary/90 transition-colors"
        >
          Connect Wallet
        </button>
        <p className="mt-3 text-[11px] text-muted-foreground text-center">
          Yields update live from Kamino & Jupiter Lend. Funds stay in your PDA‑controlled safe.
        </p>
      </section>
    );
  }

  // --- Wallet connected — Ready / Discover sections ---
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold">Strategies</h2>
        <div
          className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
          title={
            sourceState === "fallback"
              ? "Showing cached snapshot — live feed unavailable"
              : "APY feed pulled from Kamino and Jupiter Lend"
          }
        >
          <ProtocolLogo protocol="Kamino" size={5} />
          <ProtocolLogo protocol="Jupiter" size={5} />
          <span className="uppercase tracking-wide">
            {sourceState === "loading"
              ? "Loading"
              : sourceState === "fallback"
                ? "Cached"
                : (() => {
                    const rel = formatRelativeTime(fetchedAtMs ?? undefined);
                    return rel ? `Live · ${rel}` : "Live";
                  })()}
          </span>
        </div>
      </div>

      {ready.length > 0 && (
        <>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-success mb-2">
            <span className="w-1.5 h-1.5 rounded-full bg-success" />
            Ready to use · {ready.length}
          </div>
          <div className="space-y-2 mb-4">
            {ready.map(({ idea, match }) => renderIdeaCard(idea, match))}
          </div>
        </>
      )}

      {discover.length > 0 && (
        <>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
            <Sparkles className="w-3 h-3" />
            Discover · {discover.length}
          </div>
          <div className="space-y-2">
            {discover.map((idea) => renderIdeaCard(idea, null))}
          </div>
        </>
      )}

      {(actionMessage || actionError) && (
        <p className={`mt-3 text-[11px] ${actionError ? "text-destructive" : "text-muted-foreground"}`}>
          {actionError ?? actionMessage}
        </p>
      )}
    </section>
  );
}
