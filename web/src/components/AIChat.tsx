"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useChat, type UIMessage } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
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

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function latestAssistantMessage(messages: UIMessage[]): UIMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return messages[i]!;
  }
  return null;
}

const chatTransport = new DefaultChatTransport({ api: "/api/chat" });

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
              return <span key={`${message.id}-${i}`}>{part.text}</span>;
            }
            // @ts-ignore
            if (part.type === "tool-invocation" || part.type === "tool-call") {
              // @ts-ignore
              const toolName = part.toolName || part.toolInvocation?.toolName || "tool";
              return (
                <div key={`${message.id}-${i}`} className="text-xs italic opacity-50 my-1">
                  [Вызов: {toolName}...]
                </div>
              );
            }
            return null;
          })}
        </div>
      </div>
    </div>
  );
}

export function AIChat() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { publicKey, signTransaction, signAllTransactions } = wallet;

  const ownerPubkey = publicKey?.toBase58() ?? null;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const handledToolCallsRef = useRef(new Set<string>());

  const [pendingConfirm, setPendingConfirm] = useState<
    "rebalance" | "convert_all" | null
  >(null);
  const [approveBusy, setApproveBusy] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [input, setInput] = useState("");

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

  const missingPrograms = lastResult?.missingPrograms ?? [];
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
  }, [ownerPubkey]); // run once per wallet connection

  // Auto-scroll: keep pinned to bottom while streaming / new messages arrive,
  // but never fight the user if they scrolled up.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    scrollToBottom("smooth");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, status]);

  // Hook into AI tool invocations to automatically trigger confirmation UI
  useEffect(() => {
    if (!lastAssistant?.parts) return;
    lastAssistant.parts.forEach((part: any) => {
      if (part.type === "tool-invocation" || part.type === "tool-call") {
        const id = part.toolCallId;
        const toolName = part.toolName || part.toolInvocation?.toolName;
        if (id && !handledToolCallsRef.current.has(id)) {
          handledToolCallsRef.current.add(id);
          if (toolName === "rebalanceVault") {
            setPendingConfirm("rebalance");
          } else if (toolName === "convertAllToUsdc") {
            setPendingConfirm("convert_all");
          }
        }
      }
    });
  }, [lastAssistant]);

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
            : "I want to rebalance."
          : confirmed
            ? "Convert all vault tokens to USDC now (confirmed)."
            : "I want to convert all vault tokens to USDC.";

    await sendText(text, {
      clientAction: action,
      confirmed: !!confirmed,
      executionEnabled: !!confirmed,
    });
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
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
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

