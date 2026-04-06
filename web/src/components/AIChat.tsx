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
import ReactMarkdown from "react-markdown";
import { DefaultChatTransport } from "ai";
import {
  fetchVaultAccount,
  setAllowedPrograms,
} from "@/lib/vault";
import { triggerBalanceRefresh } from "@/lib/refreshEvent";
import { CHAT_HINTS } from "@/config/chat-hints";
import { useVault } from "@/hooks/useVault";
import { TokenChart } from "./TokenChart";

/* -- helpers ---------------------------------------------- */

const ACTION_PROPOSAL_RE = /@@ACTION_PROPOSAL:(rebalance|convert_all)/;
const ACTION_RESULT_RE = /^(✅|❌|⚠️)/;

function getMessageText(msg: any): string {
  if (!msg.parts) return "";
  return msg.parts
    .map((p: any) => (p.type === "text" ? p.text : ""))
    .join("")
    .trim();
}

function TypingBubble() {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] text-left">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
          AI
        </div>
        <div className="rounded-2xl px-4 py-3 bg-accent/50 text-foreground border border-border/60 flex items-center gap-1.5 min-w-[60px]">
          <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce [animation-delay:-0.3s]"></span>
          <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce [animation-delay:-0.15s]"></span>
          <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce"></span>
        </div>
      </div>
    </div>
  );
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

/* -- Action Card ------------------------------------------ */

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

/* -- Regular message bubble ------------------------------- */

function MessageBubble({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";
  const label = isUser ? "You" : "AI";

  const hasChart = message.parts.some((p: any) => p.toolName === "showTokenChart" || p.type?.startsWith("tool-showTokenChart"));

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`${hasChart && !isUser ? "w-full" : "max-w-[85%]"} ${isUser ? "text-right" : "text-left"}`}>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
          {label}
        </div>
        <div
          className={`rounded-2xl px-4 py-3 text-sm wrap-break-word border ${
            isUser
              ? "whitespace-pre-wrap bg-primary text-primary-foreground border-primary/30"
              : "bg-accent/50 text-foreground border-border/60"
          }`}
        >
          {message.parts.map((part: any, i: number) => {
            if (part.type === "text") {
              const cleaned = part.text.replace(ACTION_PROPOSAL_RE, "").trim();
              if (!cleaned) return null;
              if (isUser) {
                return <span key={`${message.id}-p${i}`}>{cleaned}</span>;
              }
              return (
                <div key={`${message.id}-p${i}`} className="prose prose-sm dark:prose-invert max-w-none break-words px-4 py-3">
                  <ReactMarkdown>{cleaned}</ReactMarkdown>
                </div>
              );
            }
            
            // Support both standard 'tool-invocation' and prefixed 'tool-toolName' types
            const isTool = part.type === "tool-invocation" || part.type?.startsWith("tool-");
            if (isTool) {
               const toolName = part.toolName || part.type?.replace("tool-", "");
               // USE RESULT/OUTPUT if available (it has the resolved mint), otherwise fall back to input args
               const toolData = part.result || part.output || part.args || part.input || part.toolInvocation?.args || {};
               
               if (toolName === "showTokenChart" && toolData.mint) {
                return (
                  <div key={part.toolCallId || `${message.id}-t${i}`} className="w-full -mx-4 -mb-3 first:-mt-3 overflow-hidden border-y border-border/40">
                    <TokenChart 
                      address={toolData.mint}
                      symbol={toolData.symbol}
                    />
                  </div>
                );
              }
            }
            return null;
          })}
          
          {/* @ts-ignore */}
          {message.toolInvocations?.map((ti: any) => {
            if (ti.toolName === "showTokenChart" && ti.state === "result") {
              return (
                <div key={ti.toolCallId} className="w-full -mx-4 -mb-3 first:-mt-3 overflow-hidden border-y border-border/40 mt-2">
                  <TokenChart 
                    address={ti.result?.mint}
                    symbol={ti.result?.symbol}
                  />
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

/* -- Chat transport --------------------------------------- */

const chatTransport = new DefaultChatTransport({ api: "/api/chat" });

/* -- Main component --------------------------------------- */

export function AIChat() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { publicKey, signTransaction, signAllTransactions } = wallet;
  const { vault } = useVault();

  const ownerPubkey = publicKey?.toBase58() ?? null;

  const chatState = !publicKey
    ? "unconnected"
    : !vault
      ? "no_vault"
      : "has_vault";

  const hints = CHAT_HINTS[chatState];

  const handleHintClick = (prompt: string) => {
    void sendText(prompt);
  };

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
    console.log(`[AIChat] Sending text: "${text}"`, extraBody);
    await sendMessage(
      { text },
      {
        body: {
          ownerPubkey: ownerPubkey ?? undefined,
          ...(extraBody ?? {}),
        },
      }
    );
  };

  const lastAssistant = useMemo(
    () => latestAssistantMessage(messages),
    [messages]
  );

  const lastMessageText = useMemo(() => {
    if (messages.length === 0) return "";
    return getMessageText(messages[messages.length - 1]);
  }, [messages]);

  const isAssistantThinking = status !== "ready" && messages[messages.length - 1]?.role === "user";

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
    scrollToBottom("smooth");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, status, lastMessageText]);

  useEffect(() => {
    // If messages are streaming, keep sticking to bottom
    if (status !== "ready" && stickToBottomRef.current) {
        scrollToBottom("auto");
    }
  }, [lastMessageText, status]);

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

  /* -- Render message with type detection ------------------- */

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

  /* -- Layout ----------------------------------------------- */

  return (
    <div className="rounded-lg border border-border bg-card flex flex-col h-full min-h-[420px] lg:min-h-0">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">AI Chat</h3>
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
          <div className="h-full flex flex-col items-center justify-center p-6 text-center">
            <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4">
              <span className="text-2xl">🤖</span>
            </div>
            <h4 className="text-lg font-semibold mb-2">How can I help you?</h4>
            <p className="text-sm text-muted-foreground mb-8 max-w-[280px]">
              Ask me about your strategy, portfolio, or request a rebalance.
            </p>
            
            <div className="flex flex-col gap-3 w-full max-w-[320px]">
              {hints.map((hint, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => handleHintClick(hint.prompt)}
                  disabled={isLoading}
                  className="w-full cursor-pointer text-sm font-medium px-4 py-3 rounded-xl border border-primary/20 bg-background text-foreground hover:bg-primary/10 hover:border-primary/40 transition-all shadow-sm disabled:opacity-50"
                >
                  {hint.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map(renderMessage)}
        {isAssistantThinking && <TypingBubble />}
      </div>

      {messages.length > 0 && hints && hints.length > 0 && (
        <div className="px-4 py-3 bg-accent/20 overflow-x-auto whitespace-nowrap hide-scrollbar border-t border-primary/20 flex gap-3 shadow-[0_-4px_12px_rgba(0,0,0,0.05)]">
          {hints.map((hint, i) => (
            <button
               key={i}
               type="button"
               onClick={() => handleHintClick(hint.prompt)}
               disabled={isLoading}
               className="cursor-pointer text-sm font-medium px-4 py-2 rounded-lg border border-primary/30 bg-background text-foreground hover:bg-primary/20 hover:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/40 hover:-translate-y-0.5 active:translate-y-0 transition-all shadow-sm disabled:opacity-50 shrink-0"
            >
              {hint.label}
            </button>
          ))}
        </div>
      )}

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
