"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { useChat, type UIMessage } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import {
  fetchVaultAccount,
  setAllowedPrograms,
} from "@/lib/vault";
import { triggerBalanceRefresh } from "@/lib/refreshEvent";

/* ── helpers ────────────────────────────────────────────── */

const ACTION_PROPOSAL_RE = /@@ACTION_PROPOSAL:(rebalance|convert_all)/;
const ACTION_RESULT_RE = /^(✅|❌|⚠️)/;

function getMessageText(msg: UIMessage): string {
  return msg.parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("")
    .trim();
}

function parseClientActionResult(text: string): Record<string, unknown> | null {
  const tag = "@@CLIENT_ACTION_RESULT";
  const idx = text.indexOf(tag);
  if (idx === -1) return null;
  try {
    return JSON.parse(text.slice(idx + tag.length).trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function latestAssistantMessage(msgs: UIMessage[]): UIMessage | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === "assistant") return msgs[i];
  }
  return undefined;
}

/* ── Action Card ────────────────────────────────────────── */

function ActionProposalCard({
  text,
  action,
  onConfirm,
  onCancel,
  disabled,
}: {
  text: string;
  action: "rebalance" | "convert_all";
  onConfirm: () => void;
  onCancel: () => void;
  disabled: boolean;
}) {
  const actionLabel = action === "rebalance" ? "Rebalance" : "Convert to USDC";
  const icon = action === "rebalance" ? "⚖️" : "💱";
  const cleanText = text.replace(ACTION_PROPOSAL_RE, "").trim();

  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] text-left">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
          AI — Action
        </div>
        <div className="rounded-2xl border-2 border-primary/40 bg-primary/5 overflow-hidden">
          <div className="px-3 py-2 flex items-center gap-2 border-b border-primary/20 bg-primary/10">
            <span className="text-base">{icon}</span>
            <span className="text-xs font-semibold text-primary uppercase tracking-wider">
              {actionLabel} — Confirmation Required
            </span>
          </div>
          <div className="px-3 py-2 text-sm whitespace-pre-wrap wrap-break-word text-foreground">
            {cleanText}
          </div>
          <div className="px-3 py-2 border-t border-primary/20 flex gap-2">
            <button
              type="button"
              onClick={onConfirm}
              disabled={disabled}
              className="cursor-pointer text-xs px-4 py-2 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
            >
              ✓ Confirm {actionLabel}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={disabled}
              className="cursor-pointer text-xs px-4 py-2 rounded-lg border border-border bg-accent hover:bg-accent/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              ✗ Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ActionResultBubble({ text }: { text: string }) {
  const isSuccess = text.startsWith("✅");
  const isError = text.startsWith("❌");
  const isWarning = text.startsWith("⚠️");

  const borderColor = isSuccess
    ? "border-success/40"
    : isError
      ? "border-destructive/40"
      : isWarning
        ? "border-yellow-500/40"
        : "border-border";
  const bgColor = isSuccess
    ? "bg-success/5"
    : isError
      ? "bg-destructive/5"
      : isWarning
        ? "bg-yellow-500/5"
        : "bg-accent";

  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] text-left">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
          AI — Result
        </div>
        <div
          className={`rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap wrap-break-word border-2 ${borderColor} ${bgColor}`}
        >
          {text}
        </div>
      </div>
    </div>
  );
}

/* ── Regular message bubble ─────────────────────────────── */

function MessageBubble({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";
  const label = isUser ? "You" : "AI";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] ${isUser ? "text-right" : "text-left"}`}>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
          {label}
        </div>
        <div
          className={`rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap wrap-break-word border ${
            isUser
              ? "bg-primary text-primary-foreground border-primary/30"
              : "bg-accent text-foreground border-border"
          }`}
        >
          {message.parts.map((part, i) => {
            if (part.type === "text") {
              // Strip @@ACTION_PROPOSAL marker from regular display
              const cleaned = part.text.replace(ACTION_PROPOSAL_RE, "").trim();
              return <span key={`${message.id}-${i}`}>{cleaned}</span>;
            }
            return null;
          })}
        </div>
      </div>
    </div>
  );
}

/* ── Chat transport ───────────────────────────────────── */

const chatTransport = new DefaultChatTransport({ api: "/api/chat" });

/* ── Main component ───────────────────────────────────── */

export function AIChat() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { publicKey, signTransaction, signAllTransactions } = wallet;

  const ownerPubkey = publicKey?.toBase58() ?? null;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const [approveBusy, setApproveBusy] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [confirmingAction, setConfirmingAction] = useState<
    "rebalance" | "convert_all" | null
  >(null);

  const {
    messages,
    error,
    sendMessage,
    status,
    clearError,
  } = useChat({
    transport: chatTransport,
  });

  const isLoading = status !== "ready";

  const sendText = async (
    text: string,
    extraBody?: Record<string, unknown>
  ): Promise<void> => {
    if (!ownerPubkey) {
      setApproveError("Wallet pubkey not ready yet");
      return;
    }
    await sendMessage(
      { text },
      {
        body: {
          ownerPubkey,
          ...(extraBody ?? {}),
        },
      }
    );
  };

  const lastAssistant = useMemo(
    () => latestAssistantMessage(messages),
    [messages]
  );

  const lastResult = useMemo(() => {
    if (!lastAssistant) return null;
    const txt = getMessageText(lastAssistant);
    return parseClientActionResult(txt);
  }, [lastAssistant]);

  const missingPrograms = (lastResult?.missingPrograms ?? []) as string[];
  const needsWhitelist =
    (lastResult?.status === "needs_whitelist" ||
      lastResult?.httpStatus === 428) &&
    missingPrograms.length > 0;

  const scrollToBottom = (behavior: ScrollBehavior) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const thresholdPx = 56;
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    stickToBottomRef.current = distanceFromBottom <= thresholdPx;
  };

  useEffect(() => {
    if (!ownerPubkey) return;
    if (messages.length === 0) {
      void sendText(
        "Summarize my current wallet and vault holdings. Explain what strategy my vault is set to. Also summarize my recent deposit/withdraw history (last 10) and net deposited."
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerPubkey]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    scrollToBottom("smooth");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, status]);

  // Trigger global balance refresh when an action succeeds
  const prevActionMessageId = useRef<string | null>(null);
  useEffect(() => {
    if (!lastAssistant || isLoading) return;
    if (prevActionMessageId.current === lastAssistant.id) return;

    const txt = getMessageText(lastAssistant);
    if (txt.startsWith("✅")) {
      triggerBalanceRefresh();
      prevActionMessageId.current = lastAssistant.id;
    }
  }, [lastAssistant, isLoading]);

  const sendClientAction = async (
    action: "snapshot" | "rebalance" | "convert_all",
    confirmed?: boolean
  ) => {
    if (!ownerPubkey) return;
    const text =
      action === "snapshot"
        ? "Refresh snapshot."
        : action === "rebalance"
          ? confirmed
            ? "Rebalance now (confirmed)."
            : "I want to rebalance my vault."
          : confirmed
            ? "Convert all vault tokens to USDC now (confirmed)."
            : "I want to convert all vault tokens to USDC.";

    await sendText(text, {
      clientAction: action,
      confirmed: !!confirmed,
      executionEnabled: !!confirmed,
    });
  };

  const handleConfirmAction = (action: "rebalance" | "convert_all") => {
    setConfirmingAction(null);
    void sendClientAction(action, true);
  };

  const handleCancelAction = () => {
    setConfirmingAction(null);
    void sendText("Cancelled — action not executed.");
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

      await sendText(
        "I signed the whitelist approval transaction. Please retry the action that failed."
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setApproveError(msg);
    } finally {
      setApproveBusy(false);
    }
  };

  /* ── Render message with type detection ─────────────── */

  const renderMessage = (msg: UIMessage) => {
    if (msg.role === "user") {
      return <MessageBubble key={msg.id} message={msg} />;
    }

    const text = getMessageText(msg);

    // Check if this is the LAST assistant message with an action proposal
    const proposalMatch = text.match(ACTION_PROPOSAL_RE);
    const isLastAssistant = msg.id === lastAssistant?.id;

    if (proposalMatch && isLastAssistant && !isLoading) {
      const action = proposalMatch[1] as "rebalance" | "convert_all";
      return (
        <ActionProposalCard
          key={msg.id}
          text={text}
          action={action}
          onConfirm={() => handleConfirmAction(action)}
          onCancel={handleCancelAction}
          disabled={isLoading}
        />
      );
    }

    // Check if this is an action result (starts with emoji)
    if (ACTION_RESULT_RE.test(text)) {
      return <ActionResultBubble key={msg.id} text={text} />;
    }

    // Regular message (strip any stale proposal markers)
    return <MessageBubble key={msg.id} message={msg} />;
  };

  /* ── Layout ─────────────────────────────────────────── */

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

  if (!ownerPubkey) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card flex flex-col h-full min-h-[420px]">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold">AI Chat</h3>
        </div>
        <div className="flex-1 flex items-center justify-center p-6 text-sm text-muted-foreground">
          Wallet connected, loading public key...
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card flex flex-col h-full min-h-[420px] lg:min-h-0">
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
            onClick={() => void sendText("I want to rebalance my vault according to strategy.")}
            disabled={isLoading}
            className="cursor-pointer text-xs px-2 py-1 rounded-md border border-border bg-accent hover:bg-accent/80 transition-colors disabled:opacity-50"
          >
            Rebalance
          </button>
          <button
            type="button"
            onClick={() => void sendText("I want to convert all vault tokens to USDC.")}
            disabled={isLoading}
            className="cursor-pointer text-xs px-2 py-1 rounded-md border border-border bg-accent hover:bg-accent/80 transition-colors disabled:opacity-50"
          >
            Convert all
          </button>
        </div>
      </div>

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

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-auto p-4 space-y-3 scrollbar-pretty"
      >
        {messages.length === 0 && (
          <div className="text-sm text-muted-foreground">
            Ask about your vault strategy, risk, or request a rebalance.
          </div>
        )}
        {messages.map(renderMessage)}
      </div>

      <form
        onSubmit={(e) => {
          setApproveError(null);
          e.preventDefault();
          clearError();
          const text = input.trim();
          if (!text) return;
          void sendText(text);
          setInput("");
        }}
        className="p-3 border-t border-border"
      >
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about your strategy or request an action..."
            className="flex-1 py-2.5 px-3 rounded-md bg-accent border border-border text-sm"
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="cursor-pointer py-2.5 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
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
