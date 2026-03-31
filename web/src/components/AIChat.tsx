"use client";

import { useEffect, useMemo, useState } from "react";
import { useChat, type Message } from "ai/react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { fetchVaultAccount, setAllowedPrograms } from "@/lib/vault";

type ClientActionResult = {
  status?: string;
  missingPrograms?: string[];
  swaps?: unknown[];
  signatures?: string[];
  error?: string;
  httpStatus?: number;
};

function parseClientActionResult(text: string): ClientActionResult | null {
  const marker = "@@CLIENT_ACTION_RESULT";
  const idx = text.lastIndexOf(marker);
  if (idx === -1) return null;
  const raw = text.slice(idx + marker.length).trim();
  try {
    return JSON.parse(raw) as ClientActionResult;
  } catch {
    return null;
  }
}

function latestAssistantMessage(messages: Message[]): Message | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return messages[i]!;
  }
  return null;
}

export function AIChat() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { publicKey, signTransaction, signAllTransactions } = wallet;

  const ownerPubkey = publicKey?.toBase58() ?? null;

  const [pendingConfirm, setPendingConfirm] = useState<
    "rebalance" | "convert_all" | null
  >(null);
  const [approveBusy, setApproveBusy] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    append,
    isLoading,
    error,
    setInput,
  } = useChat({
    api: "/api/chat",
    body: ownerPubkey ? { ownerPubkey } : {},
  });

  const lastAssistant = useMemo(
    () => latestAssistantMessage(messages),
    [messages]
  );

  const lastResult = useMemo(() => {
    const txt = lastAssistant?.content ?? "";
    return parseClientActionResult(txt);
  }, [lastAssistant]);

  const missingPrograms = lastResult?.missingPrograms ?? [];
  const needsWhitelist =
    (lastResult?.status === "needs_whitelist" ||
      lastResult?.httpStatus === 428) &&
    missingPrograms.length > 0;

  useEffect(() => {
    if (!ownerPubkey) return;
    if (messages.length === 0) {
      void append({
        role: "user",
        content:
          "Summarize my current wallet and vault holdings. Explain what strategy my vault is set to. Also summarize my recent deposit/withdraw history (last 10) and net deposited.",
      });
    }
  }, [ownerPubkey]); // intentionally not depending on messages/append

  const sendClientAction = async (
    action: "snapshot" | "rebalance" | "convert_all",
    confirmed?: boolean
  ) => {
    if (!ownerPubkey) return;
    await append(
      {
        role: "user",
        content:
          action === "snapshot"
            ? "Refresh snapshot."
            : action === "rebalance"
              ? confirmed
                ? "Rebalance now (confirmed)."
                : "I want to rebalance."
              : confirmed
                ? "Convert all vault tokens to USDC now (confirmed)."
                : "I want to convert all vault tokens to USDC.",
      },
      {
        body: {
          ownerPubkey,
          clientAction: action,
          confirmed: !!confirmed,
          executionEnabled: !!confirmed,
        },
      }
    );
  };

  const approveWhitelist = async () => {
    setApproveError(null);
    if (!ownerPubkey || !publicKey || !signTransaction || !signAllTransactions) {
      setApproveError("Wallet not connected");
      return;
    }
    if (!needsWhitelist) return;

    setApproveBusy(true);
    try {
      const provider = new AnchorProvider(
        connection,
        { publicKey, signTransaction, signAllTransactions } as never,
        { preflightCommitment: "confirmed" }
      );

      const vault = await fetchVaultAccount(connection, publicKey);
      if (!vault) throw new Error("Vault not found for this wallet");

      const existing = new Set(
        (vault.allowedPrograms ?? []).map((p) => p.toBase58())
      );
      for (const p of missingPrograms) existing.add(p);

      const merged = [...existing].map((p) => new PublicKey(p));
      await setAllowedPrograms(provider, merged);

      await append({
        role: "user",
        content:
          "I signed the whitelist approval transaction. Please retry the action that failed.",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setApproveError(msg);
    } finally {
      setApproveBusy(false);
    }
  };

  if (!publicKey) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card flex flex-col h-full min-h-[420px]">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold">AI Chat</h3>
        </div>
        <div className="flex-1 flex items-center justify-center p-6 text-sm text-muted-foreground">
          Connect your wallet to use chat.
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card flex flex-col h-full min-h-[420px]">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">AI Chat</h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void sendClientAction("snapshot")}
            disabled={isLoading}
            className="cursor-pointer text-xs px-2 py-1 rounded-md border border-border bg-accent hover:bg-accent/80 transition-colors disabled:opacity-50"
          >
            Snapshot
          </button>
          <button
            type="button"
            onClick={() => setPendingConfirm("rebalance")}
            disabled={isLoading}
            className="cursor-pointer text-xs px-2 py-1 rounded-md border border-border bg-accent hover:bg-accent/80 transition-colors disabled:opacity-50"
          >
            Rebalance
          </button>
          <button
            type="button"
            onClick={() => setPendingConfirm("convert_all")}
            disabled={isLoading}
            className="cursor-pointer text-xs px-2 py-1 rounded-md border border-border bg-accent hover:bg-accent/80 transition-colors disabled:opacity-50"
          >
            Convert all
          </button>
        </div>
      </div>

      {pendingConfirm && (
        <div className="px-4 py-3 border-b border-border bg-primary/5">
          <div className="text-xs text-muted-foreground">
            This will send transactions via the agent for your vault. Confirm?
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => {
                const act = pendingConfirm;
                setPendingConfirm(null);
                void sendClientAction(
                  act === "rebalance" ? "rebalance" : "convert_all",
                  true
                );
              }}
              className="cursor-pointer text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setPendingConfirm(null)}
              className="cursor-pointer text-xs px-3 py-1.5 rounded-md border border-border bg-accent hover:bg-accent/80 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {needsWhitelist && (
        <div className="px-4 py-3 border-b border-border bg-primary/10">
          <div className="text-sm font-medium">One-time whitelist required</div>
          <div className="text-xs text-muted-foreground mt-1">
            Your vault must whitelist swap programs before the agent can execute
            routes. You will sign a one-time on-chain transaction as the vault
            owner.
          </div>
          <div className="mt-2">
            <button
              type="button"
              onClick={() => void approveWhitelist()}
              disabled={approveBusy}
              className="cursor-pointer text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {approveBusy ? "Approving..." : "Approve whitelist"}
            </button>
          </div>
            <div className="mt-2 text-[11px] text-muted-foreground font-mono break-all">
            Missing: {missingPrograms.join(", ")}
          </div>
          {approveError && (
            <div className="mt-2 text-xs text-destructive">{approveError}</div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-auto p-4 space-y-3">
        {messages.length === 0 && (
          <div className="text-sm text-muted-foreground">
            Ask about your vault strategy, risk, or request a rebalance.
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className="space-y-1">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {m.role}
            </div>
            <div className="text-sm whitespace-pre-wrap wrap-break-word">
              {m.content}
            </div>
          </div>
        ))}
        {(error || approveError) && null}
      </div>

      <form
        onSubmit={(e) => {
          setApproveError(null);
          handleSubmit(e);
        }}
        className="p-3 border-t border-border"
      >
        <div className="flex gap-2">
          <input
            value={input}
            onChange={handleInputChange}
            placeholder="Ask about your strategy or request an action..."
            className="flex-1 py-2 px-3 rounded-md bg-accent border border-border text-sm"
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="cursor-pointer py-2 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => {
              if (!input.trim()) return;
              // If the user types "rebalance" or "convert", we still require confirmation via buttons.
              if (/\\brebalance\\b/i.test(input) || /\\bconvert\\b/i.test(input)) {
                setInput(input + " (no execution without confirmation)");
              }
            }}
          >
            {isLoading ? "..." : "Send"}
          </button>
        </div>
        {error && (
          <div className="mt-2 text-xs text-destructive">{error.message}</div>
        )}
      </form>
    </div>
  );
}

