"use client";

import { useEffect, useMemo, useState } from "react";
import { ShieldCheck, Sparkles } from "lucide-react";
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

function TokenChip({ mint, dimmed }: { mint: string; dimmed?: boolean }) {
  const [failed, setFailed] = useState(false);
  const src = mintLogoUrl(mint);
  const symbol = EARN_IDEA_SYMBOLS[mint] ?? mint.slice(0, 4);
  const cls = `w-5 h-5 rounded-full bg-muted ring-1 ring-border ${dimmed ? "opacity-60" : ""}`;
  if (src && !failed) {
    return <img src={src} alt={symbol} className={cls} onError={() => setFailed(true)} />;
  }
  return (
    <div
      className={`${cls} flex items-center justify-center text-[9px] font-bold text-muted-foreground`}
      title={symbol}
    >
      {symbol.charAt(0)}
    </div>
  );
}

function ProtocolLogo({ protocol }: { protocol: string }) {
  const logo = protocolLogo(protocol);
  const [failed, setFailed] = useState(false);
  if (!logo || failed) {
    return (
      <div className="w-7 h-7 rounded-md bg-muted ring-1 ring-border flex items-center justify-center text-[10px] font-bold text-muted-foreground">
        {protocol.charAt(0)}
      </div>
    );
  }
  return (
    <img
      src={logo.src}
      alt={logo.alt}
      className="w-7 h-7 rounded-md bg-card ring-1 ring-border p-1"
      onError={() => setFailed(true)}
    />
  );
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

  function renderIdeaCard(idea: EarnIdea, match: OwnedMatch | null) {
    const isReady = match !== null;
    const inVault = match?.location === "vault";
    const canActivate =
      isReady && inVault && idea.action?.type === "kaminoKvaultDeposit";
    const showMoveToVault =
      isReady && !inVault && idea.action?.type === "kaminoKvaultDeposit";

    // Asset chips: requiredMints, but cap to 3 to avoid clutter.
    const chips = idea.requiredMints.slice(0, 3);
    const extraChips = idea.requiredMints.length - chips.length;

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
          <ProtocolLogo protocol={idea.protocol} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2 min-w-0">
                <h3 className="text-sm font-medium truncate">{idea.title}</h3>
                <div className="flex items-center -space-x-1 shrink-0">
                  {chips.map((mint) => (
                    <TokenChip key={mint} mint={mint} dimmed={!isReady} />
                  ))}
                  {extraChips > 0 && (
                    <span className="text-[10px] text-muted-foreground ml-1.5">
                      +{extraChips}
                    </span>
                  )}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-sm font-semibold text-success">{idea.apyLabel}</div>
                {idea.spreadLabel && (
                  <div className="text-[10px] text-primary">{idea.spreadLabel}</div>
                )}
              </div>
            </div>

            {/* Owned/Discover sub-line */}
            {isReady ? (
              <div className="mt-1 text-[11px] text-success font-medium">
                {formatBalance(match.balance)} {match.symbol} in{" "}
                {match.location === "vault" ? "safe" : "wallet"}
              </div>
            ) : idea.borrowLabel ? (
              <div className="mt-1 text-[11px] text-muted-foreground">
                {idea.borrowLabel}
              </div>
            ) : null}

            {canActivate && (
              <button
                type="button"
                disabled={pendingIdeaId !== null}
                onClick={() => void handleKaminoDeposit(idea)}
                className="mt-2 inline-flex h-7 items-center rounded-md bg-primary text-primary-foreground px-3 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pendingIdeaId === idea.id ? "Activating..." : "Activate"}
              </button>
            )}
            {showMoveToVault && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Move {match.symbol} to the safe first to activate in one click.
              </p>
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
        <h2 className="text-sm font-semibold">Earn ideas</h2>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1.5 py-0.5">
          {sourceState === "loading" ? "loading" : sourceState === "live" ? "live" : "fallback"}
        </span>
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
