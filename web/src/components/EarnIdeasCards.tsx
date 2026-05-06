"use client";

import { useEffect, useMemo, useState } from "react";
import { BadgeDollarSign, Landmark, Layers3, Sparkles } from "lucide-react";
import { useWallet } from "@solana/wallet-adapter-react";
import { deriveVaultPda } from "@/lib/vault";
import { useVault } from "@/hooks/useVault";
import { useVaultAssets } from "@/hooks/useVaultAssets";
import { useWalletAssets } from "@/hooks/useWalletAssets";
import { EARN_IDEAS, EARN_IDEA_SYMBOLS, type EarnIdea } from "@/lib/earnIdeas";
import { triggerBalanceRefresh } from "@/lib/refreshEvent";
import { formatWalletError } from "@/lib/walletError";

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

function iconForFocus(focus: EarnIdea["focus"]) {
  if (focus === "USDC") return <BadgeDollarSign className="w-4 h-4" />;
  if (focus === "RWA") return <Landmark className="w-4 h-4" />;
  if (focus === "xStocks") return <Layers3 className="w-4 h-4" />;
  return <Sparkles className="w-4 h-4" />;
}

export function EarnIdeasCards() {
  const { publicKey } = useWallet();
  const { vault, updateAllowlist } = useVault();
  const vaultPda = publicKey && vault ? deriveVaultPda(publicKey)[0] : null;
  const { assets: vaultAssets } = useVaultAssets(vaultPda);
  const { assets: walletAssets } = useWalletAssets();
  const [ideas, setIdeas] = useState<EarnIdea[]>(EARN_IDEAS);
  const [sourceState, setSourceState] = useState<"loading" | "live" | "fallback">("loading");
  const [pendingIdeaId, setPendingIdeaId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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

  const ownedMints = useMemo(() => {
    const out = new Set<string>();
    for (const asset of [...walletAssets, ...vaultAssets]) {
      if (asset.balance > 0) out.add(asset.mint);
    }
    return out;
  }, [walletAssets, vaultAssets]);

  const postKaminoDeposit = async (idea: EarnIdea): Promise<ActionResponse> => {
    if (!publicKey) throw new Error("Wallet not connected");
    if (!idea.action || idea.action.type !== "kaminoKvaultDeposit") {
      throw new Error("This idea is not executable yet");
    }

    const holding = vaultAssets.find((asset) => asset.mint === idea.action?.tokenMint);
    if (!holding || BigInt(holding.rawAmount) === BigInt(0)) {
      throw new Error(`No ${EARN_IDEA_SYMBOLS[idea.action.tokenMint] ?? "token"} in vault`);
    }

    const res = await fetch("/api/kamino/kvault/deposit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ownerPubkey: publicKey.toBase58(),
        kvault: idea.action.kvault,
        amountRaw: holding.rawAmount,
        decimals: holding.decimals,
      }),
    });

    return (await res.json()) as ActionResponse;
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

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="text-sm font-semibold">Earn ideas</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Snapshot-based candidates for USDC, SOL, BTC, xStocks, and OnRe.
          </p>
        </div>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1.5 py-0.5">
          {sourceState === "loading" ? "loading" : sourceState === "live" ? "live" : "fallback"}
        </span>
      </div>

      <div className="space-y-2">
        {ideas.map((idea) => {
          const ownedSymbols = idea.requiredMints
            .filter((mint) => ownedMints.has(mint))
            .map((mint) => EARN_IDEA_SYMBOLS[mint] ?? mint.slice(0, 4));
          const hasUserAsset = ownedSymbols.length > 0;
          const vaultActionHolding = idea.action
            ? vaultAssets.find((asset) => asset.mint === idea.action?.tokenMint)
            : null;
          const canDepositFromVault =
            !!vaultActionHolding && BigInt(vaultActionHolding.rawAmount) > BigInt(0);

          return (
            <article
              key={idea.id}
              className={`rounded-md border p-3 transition-colors ${
                hasUserAsset
                  ? "border-primary/50 bg-primary/10"
                  : "border-border bg-accent/30"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex w-7 h-7 items-center justify-center rounded-md border ${
                        hasUserAsset
                          ? "border-primary/40 bg-primary/20 text-primary"
                          : "border-border bg-background text-muted-foreground"
                      }`}
                    >
                      {iconForFocus(idea.focus)}
                    </span>
                    <div className="min-w-0">
                      <h3 className="text-sm font-medium truncate">{idea.title}</h3>
                      <div className="text-[11px] text-muted-foreground">
                        {idea.protocol} · {idea.focus}
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2 leading-snug">
                    {idea.description}
                  </p>
                </div>

                <div className="text-right shrink-0">
                  <div className="text-sm font-semibold text-success">{idea.apyLabel}</div>
                  {idea.spreadLabel && (
                    <div className="text-[11px] text-primary">{idea.spreadLabel}</div>
                  )}
                </div>
              </div>

              {idea.borrowLabel && (
                <div className="mt-2 text-[11px] text-muted-foreground">
                  {idea.borrowLabel}
                </div>
              )}

              <div className="mt-2 flex flex-wrap gap-1.5">
                {hasUserAsset ? (
                  <span className="text-[10px] font-medium rounded border border-primary/40 bg-primary/15 text-primary px-1.5 py-0.5">
                    You hold {ownedSymbols.slice(0, 3).join(", ")}
                    {ownedSymbols.length > 3 ? ` +${ownedSymbols.length - 3}` : ""}
                  </span>
                ) : (
                  <span className="text-[10px] rounded border border-border bg-background text-muted-foreground px-1.5 py-0.5">
                    No matching holding
                  </span>
                )}
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground leading-snug">
                {idea.note}
              </p>
              {idea.action?.type === "kaminoKvaultDeposit" && (
                <button
                  type="button"
                  disabled={!canDepositFromVault || pendingIdeaId !== null}
                  onClick={() => void handleKaminoDeposit(idea)}
                  className="mt-2 inline-flex h-8 items-center rounded-md border border-primary/40 bg-primary text-primary-foreground px-3 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pendingIdeaId === idea.id
                    ? "Depositing..."
                    : canDepositFromVault
                      ? `Deposit vault ${vaultActionHolding?.symbol ?? "USDC"}`
                      : "No vault USDC"}
                </button>
              )}
            </article>
          );
        })}
      </div>
      {(actionMessage || actionError) && (
        <p className={`mt-3 text-[11px] ${actionError ? "text-destructive" : "text-muted-foreground"}`}>
          {actionError ?? actionMessage}
        </p>
      )}
    </section>
  );
}
