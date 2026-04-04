import { NextResponse, type NextRequest } from "next/server";
import {
  streamText,
  tool,
  convertToModelMessages,
  type UIMessage,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchVaultAccount, deriveVaultPda, parseStrategy } from "@/lib/vault";
import { fetchPortfolioAssets } from "@/lib/portfolioAssets";
import { PROGRAM_ID, RPC_URL } from "@/lib/constants";
import { fetchVaultHistory } from "@/lib/vaultHistory";
import { STRATEGY_DEFS, formatTargetMix } from "@/lib/strategies";
import { runRebalanceJob } from "@/server/agent/runRebalance";

export const runtime = "nodejs";

function openRouterModel() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const baseURL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
  const model = process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";

  const client = createOpenAI({
    apiKey,
    baseURL,
    headers: {
      // Optional but recommended by OpenRouter.
      "HTTP-Referer": process.env.OPENROUTER_REFERRER ?? "http://localhost:3000",
      "X-Title": process.env.OPENROUTER_APP_NAME ?? "Yield AI",
    },
  });

  // OpenAI provider defaults to the Responses API (POST /responses),
  // but OpenRouter is OpenAI-*compatible* via Chat Completions (POST /chat/completions).
  // Force chat mode to avoid "Invalid Responses API request".
  return client.chat(model as never);
}

async function getConnection(): Promise<Connection> {
  return new Connection(process.env.NEXT_PUBLIC_RPC_URL || RPC_URL, "confirmed");
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      messages?: UIMessage[];
      ownerPubkey?: string;
      clientAction?: "snapshot" | "rebalance" | "convert_all";
      confirmed?: boolean;
      executionEnabled?: boolean;
    };

    const messages = body.messages ?? [];
    const ownerPubkey = body.ownerPubkey;
    if (!ownerPubkey) {
      return NextResponse.json(
        { error: "ownerPubkey is required" },
        { status: 400 }
      );
    }

    const model = openRouterModel();

    const connection = await getConnection();
    const owner = new PublicKey(ownerPubkey);
    const [vaultPda] = deriveVaultPda(owner);

    const getUiText = (m: UIMessage | undefined): string => {
      if (!m) return "";
      return m.parts
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("")
        .trim();
    };

    const lastUserText = (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === "user") return getUiText(messages[i]);
      }
      return "";
    })();

    const isCyrillic = /[А-Яа-яЁё]/.test(lastUserText);
    const replyLang: "ru" | "en" = isCyrillic ? "ru" : "en";

    // --- Chat-based confirmation detection ---
    // If the user typed something like "да", "yes", "confirm", "подтверждаю",
    // and the previous assistant message was about needing confirmation for an action,
    // we auto-enable execution and infer the action.
    const CONFIRM_RE = /^(да|yes|confirm|подтверждаю|ок|ok|go|давай|вперед|вперёд|точно|sure|do it|execute|запускай|погнали)\s*[.!]?\s*$/i;

    const prevAssistantText = (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === "assistant") return getUiText(messages[i]);
      }
      return "";
    })();

    const userIsConfirming = CONFIRM_RE.test(lastUserText.trim());

    // Detect which action the assistant was asking about
    let inferredAction: "rebalance" | "convert_all" | null = null;
    if (userIsConfirming && prevAssistantText) {
      const lower = prevAssistantText.toLowerCase();
      if (lower.includes("convert") || lower.includes("конверт") || lower.includes("usdc") || lower.includes("продать")) {
        inferredAction = "convert_all";
      } else if (lower.includes("rebalance") || lower.includes("ребаланс")) {
        inferredAction = "rebalance";
      }
    }

    let executionEnabled = body.executionEnabled === true;
    if (inferredAction && !executionEnabled) {
      executionEnabled = true;
      body.clientAction = inferredAction;
      body.confirmed = true;
    }

    // Always provide a compact, fresh snapshot so the assistant can answer questions
    // like "how much USDC do I have?" without needing an explicit tool call.
    const [walletSnap, vaultHoldingsSnap] = await Promise.all([
      fetchPortfolioAssets(connection, owner, { includeSol: true }),
      fetchPortfolioAssets(connection, vaultPda, { includeSol: false }),
    ]);

    const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

    const walletUsdc = walletSnap.assets.find((a) => a.mint === USDC_MINT)
      ?.balance ?? 0;
    const vaultUsdc = vaultHoldingsSnap.assets.find((a) => a.mint === USDC_MINT)
      ?.balance ?? 0;

    const pickTopAssets = (assets: typeof walletSnap.assets, limit: number) =>
      assets
        .slice()
        .sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0))
        .slice(0, limit)
        .map((a) => ({
          mint: a.mint,
          symbol: a.symbol,
          name: a.name,
          balance: a.balance,
          usdPrice: a.usdPrice,
          usdValue: a.usdValue,
        }));

    const pickUnpricedAssets = (assets: typeof walletSnap.assets, limit: number) =>
      assets
        .filter((a) => a.balance > 0 && a.usdPrice == null)
        .slice(0, limit)
        .map((a) => ({
          mint: a.mint,
          symbol: a.symbol,
          name: a.name,
          balance: a.balance,
        }));

    const portfolioContext = {
      ownerPubkey,
      vaultPda: vaultPda.toBase58(),
      wallet: {
        totalUsd: walletSnap.totalUsd,
        assetCount: walletSnap.assets.length,
        topAssets: pickTopAssets(walletSnap.assets, 40),
        unpricedAssets: pickUnpricedAssets(walletSnap.assets, 25),
      },
      vault: {
        totalUsd: vaultHoldingsSnap.totalUsd,
        assetCount: vaultHoldingsSnap.assets.length,
        topAssets: pickTopAssets(vaultHoldingsSnap.assets, 40),
        unpricedAssets: pickUnpricedAssets(vaultHoldingsSnap.assets, 25),
      },
    };

    // Deterministic token balance answers to avoid LLM hallucination.
    // Handles questions like: "сколько у меня ONyc?", "how much USDC in vault?"
    const tokenQueryMatch = lastUserText.match(
      /\b(?:сколько|how\s+much)\b[\s\S]{0,40}\b([A-Za-z][A-Za-z0-9]{1,14})\b/i
    );
    if (tokenQueryMatch) {
      const rawToken = tokenQueryMatch[1] ?? "";
      const token = rawToken.trim();
      const tokenUpper = token.toUpperCase();

      const findBySymbol = (assets: typeof walletSnap.assets) =>
        assets.find((a) => (a.symbol ?? "").toUpperCase() === tokenUpper) ??
        assets.find((a) =>
          (a.name ?? "").toUpperCase().includes(tokenUpper)
        );

      const walletAsset = findBySymbol(walletSnap.assets);
      const vaultAsset = findBySymbol(vaultHoldingsSnap.assets);

      const fmtUsd = (n: number | null | undefined) =>
        n == null ? "unavailable" : `$${n.toFixed(2)}`;

      const lines: string[] = [];
      lines.push(replyLang === "ru" ? `Токен: ${tokenUpper}` : `Token: ${tokenUpper}`);

      if (!walletAsset && !vaultAsset) {
        lines.push(
          replyLang === "ru"
            ? "Я не вижу этот токен в текущем снапшоте кошелька или vault."
            : "I don't see this token in your current wallet or vault snapshot."
        );
      } else {
        if (walletAsset) {
          lines.push(
            `Wallet: ${walletAsset.balance.toLocaleString("en-US", {
              maximumFractionDigits: 6,
            })} ${walletAsset.symbol} (${fmtUsd(walletAsset.usdValue)})`
          );
        } else {
          lines.push("Wallet: 0");
        }

        if (vaultAsset) {
          lines.push(
            `Vault: ${vaultAsset.balance.toLocaleString("en-US", {
              maximumFractionDigits: 6,
            })} ${vaultAsset.symbol} (${fmtUsd(vaultAsset.usdValue)})`
          );
        } else {
          lines.push("Vault: 0");
        }
      }

      return createUIMessageStreamResponse({
        status: 200,
        stream: createUIMessageStream({
          execute({ writer }) {
            const id = "token-balance";
            writer.write({ type: "text-start", id });
            writer.write({
              type: "text-delta",
              id,
              delta: lines.join("\n"),
            });
            writer.write({ type: "text-end", id });
          },
        }),
      });
    }

    let actionPreface = "";
    if (body.clientAction === "snapshot") {
      const snapVault = await fetchVaultAccount(connection, owner);
      const [wallet, vaultHoldings] = await Promise.all([
        fetchPortfolioAssets(connection, owner, { includeSol: true }),
        fetchPortfolioAssets(connection, vaultPda, { includeSol: false }),
      ]);
      actionPreface =
        "Client requested a fresh snapshot.\n" +
        JSON.stringify(
          {
            ownerPubkey,
            vaultPda: vaultPda.toBase58(),
            vault: snapVault
              ? {
                  strategy: parseStrategy(snapVault.strategy),
                  allowedPrograms: (snapVault.allowedPrograms ?? []).map((p) =>
                    p.toBase58()
                  ),
                }
              : null,
            wallet,
            vaultHoldings,
          },
          null,
          2
        );
    } else if (
      body.clientAction === "rebalance" ||
      body.clientAction === "convert_all"
    ) {
      if (!body.confirmed || !executionEnabled) {
        actionPreface =
          "Client attempted an execution action without confirmation. Ask the user to confirm explicitly.";
      } else {
        const action =
          body.clientAction === "rebalance" ? "rebalance" : "convert_all";
        try {
          const data = await runRebalanceJob({ ownerPubkey, action });
          actionPreface =
            `Client executed action=${action} (confirmed).\n` +
            JSON.stringify(data, null, 2);
        } catch (execErr: unknown) {
          const errMsg = execErr instanceof Error ? execErr.message : String(execErr);
          console.error("[chat] runRebalanceJob failed:", errMsg, execErr);
          actionPreface =
            `Client executed action=${action} (confirmed) but it FAILED.\nError: ${errMsg}\n` +
            "Tell the user what went wrong. If it is a missing env var or configuration issue, explain that.";
        }
      }
    }

    const result = streamText({
      model,
      messages: await convertToModelMessages(messages),
      system: [
        "You are an AI portfolio assistant for a Solana vault.",
        "Your job: help the user understand their current portfolio, discuss strategy, and propose explicit actions.",
        replyLang === "ru"
          ? "Language: reply in Russian."
          : "Language: reply in English.",
        "Always reply in the same language as the user's last message.",
        "Context:",
        `- ownerPubkey: ${ownerPubkey}`,
        `- vaultPda: ${vaultPda.toBase58()}`,
        `- walletUsdc: ${walletUsdc}`,
        `- vaultUsdc: ${vaultUsdc}`,
        `- walletTotalUsd: ${walletSnap.totalUsd}`,
        `- vaultTotalUsd: ${vaultHoldingsSnap.totalUsd}`,
        "Portfolio snapshot (server-fetched, authoritative):",
        JSON.stringify(portfolioContext, null, 2),
        "Answering rules:",
        "- If user asks 'how much <TOKEN> do I have', look for that token by symbol in wallet.topAssets and vault.topAssets above.",
        "- Always respond with BOTH: token amount and USD value (if usdPrice is null, say USD value is unavailable).",
        "- If the token is not present in the snapshot, say so explicitly (do not guess).",
        "- If unpricedAssets contains tokens, explain that totals can be understated because market prices were unavailable.",
        "Strategy definitions (authoritative):",
        JSON.stringify(
          Object.fromEntries(
            Object.entries(STRATEGY_DEFS).map(([k, v]) => [
              k,
              {
                risk: v.risk,
                summary: v.summary,
                targetMix: formatTargetMix(v),
              },
            ])
          ),
          null,
          2
        ),
        "Safety rules:",
        "- Never instruct the user to share private keys or seed phrases.",
        "- Never attempt withdrawals. Owner withdrawals must be done by the user outside this chat.",
        "- When the user asks to rebalance or convert to USDC, do NOT execute immediately.",
        "  Instead, briefly explain what you are about to do and ask the user to confirm by typing 'да', 'yes', 'confirm', 'давай', etc.",
        "  Once confirmed, the system will automatically execute the action on the next message.",
        "- Do NOT tell the user to use UI buttons. The user can confirm via chat text.",
        "Tool usage:",
        "- Use getPortfolioSnapshot to ground your analysis in current on-chain balances.",
        "- Do NOT call rebalanceVault or convertAllToUsdc tools directly. Actions are triggered via the client action protocol below.",
        "When you return an execution recommendation, always explain what will happen on-chain and why.",
        "Client action protocol:",
        "- If the system prompt contains a section 'Context from the client action' with JSON, you MUST include a final line in your answer:",
        "  @@CLIENT_ACTION_RESULT <the exact same JSON, minified or pretty is OK, but must be valid JSON>",
        "- Do not fabricate fields in that JSON; echo it as given.",
        actionPreface ? `\nContext from the client action:\n${actionPreface}` : "",
      ].join("\n"),
      tools: {
        getStrategyExplainer: tool({
          description:
            "Explain strategy meaning, risk, and target mix. Uses authoritative strategy definitions.",
          inputSchema: z.object({
            strategy: z.enum(["Conservative", "Balanced", "Growth"]).optional(),
          }),
          execute: async ({ strategy }) => {
            const picked = strategy ?? parseStrategy((await fetchVaultAccount(connection, owner))!.strategy);
            const def = STRATEGY_DEFS[picked];
            return {
              strategy: def.name,
              risk: def.risk,
              summary: def.summary,
              targetMix: def.targetMix,
              targetMixText: formatTargetMix(def),
            };
          },
        }),
        getPortfolioSnapshot: tool({
          description:
            "Fetch wallet + vault snapshot (current holdings, USD values, vault strategy, whitelist).",
          inputSchema: z.object({
            ownerPubkey: z.string().optional(),
          }),
          execute: async ({ ownerPubkey: toolOwnerPubkey }) => {
            const connection = await getConnection();
            const resolvedOwnerPubkey = toolOwnerPubkey ?? ownerPubkey;
            const owner = new PublicKey(resolvedOwnerPubkey);

            const [vaultPda] = deriveVaultPda(owner);
            const vault = await fetchVaultAccount(connection, owner);

            const [wallet, vaultHoldings] = await Promise.all([
              fetchPortfolioAssets(connection, owner, { includeSol: true }),
              fetchPortfolioAssets(connection, vaultPda, { includeSol: false }),
            ]);

            return {
              ownerPubkey: resolvedOwnerPubkey,
              vault: vault
                ? {
                    vaultPda: vaultPda.toBase58(),
                    strategy: parseStrategy(vault.strategy),
                    lastRebalanceTs: vault.lastRebalanceTs?.toString?.() ?? null,
                    allowedPrograms: (vault.allowedPrograms ?? []).map((p) =>
                      p.toBase58()
                    ),
                  }
                : null,
              wallet,
              vaultHoldings,
            };
          },
        }),

        rebalanceVault: tool({
          description:
            "Trigger an offchain agent rebalance for the owner's vault. Requires explicit confirmation.",
          inputSchema: z.object({
            ownerPubkey: z.string().optional(),
            confirmed: z.boolean().default(false),
          }),
          execute: async ({ ownerPubkey: toolOwnerPubkey, confirmed }) => {
            if (!executionEnabled) {
              return {
                status: "error",
                error:
                  "Execution is disabled for this request. Use the UI confirmation buttons to enable execution.",
              };
            }
            if (!confirmed) {
              return {
                status: "error",
                error:
                  "Confirmation required. Ask the user to confirm before rebalancing.",
              };
            }

            const resolvedOwnerPubkey = toolOwnerPubkey ?? ownerPubkey;
            const data = await runRebalanceJob({ ownerPubkey: resolvedOwnerPubkey, action: "rebalance" });
            return data;
          },
        }),

        convertAllToUsdc: tool({
          description:
            "Convert all vault holdings to USDC via the agent (pre-withdraw). Requires explicit confirmation.",
          inputSchema: z.object({
            ownerPubkey: z.string().optional(),
            confirmed: z.boolean().default(false),
          }),
          execute: async ({ ownerPubkey: toolOwnerPubkey, confirmed }) => {
            if (!executionEnabled) {
              return {
                status: "error",
                error:
                  "Execution is disabled for this request. Use the UI confirmation buttons to enable execution.",
              };
            }
            if (!confirmed) {
              return {
                status: "error",
                error:
                  "Confirmation required. Ask the user to confirm before converting.",
              };
            }

            const resolvedOwnerPubkey = toolOwnerPubkey ?? ownerPubkey;
            const data = await runRebalanceJob({ ownerPubkey: resolvedOwnerPubkey, action: "convert_all" });
            return data;
          },
        }),

        getVaultHistory: tool({
          description:
            "Fetch a compact vault deposit/withdraw history summary for the owner's vault PDA.",
          inputSchema: z.object({
            ownerPubkey: z.string().optional(),
            limit: z.number().int().min(1).max(50).default(20),
          }),
          execute: async ({ ownerPubkey: toolOwnerPubkey, limit }) => {
            const connection = await getConnection();
            const resolvedOwnerPubkey = toolOwnerPubkey ?? ownerPubkey;
            const owner = new PublicKey(resolvedOwnerPubkey);
            const [vaultPda] = deriveVaultPda(owner);

            const data = await fetchVaultHistory(connection, PROGRAM_ID, vaultPda);
            const entries = data.entries.slice(-limit);

            return {
              ownerPubkey: resolvedOwnerPubkey,
              vaultPda: vaultPda.toBase58(),
              totalDeposited: data.totalDeposited,
              totalWithdrawn: data.totalWithdrawn,
              netDeposited: data.netDeposited,
              entries,
            };
          },
        }),
      },
    });

    return result.toUIMessageStreamResponse({
      onError: (error) => {
        const msg = error instanceof Error ? error.message : String(error);
        // IMPORTANT: must return a string (becomes errorText in the stream).
        return msg.includes("OPENROUTER_API_KEY")
          ? "Server is missing OPENROUTER_API_KEY."
          : "Chat request failed. Check server logs.";
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // IMPORTANT: useChat expects a UI message stream response.
    // If we return JSON here, the client will throw "Invalid Responses API request".
    return createUIMessageStreamResponse({
      status: 500,
      statusText: "Internal Server Error",
      stream: createUIMessageStream({
        execute({ writer }) {
          const id = "server-error";
          writer.write({ type: "text-start", id });
          writer.write({
            type: "text-delta",
            id,
            delta:
              "Server error while processing chat.\n" +
              (message.includes("OPENROUTER_API_KEY")
                ? "Missing OPENROUTER_API_KEY on the server."
                : "Check the server logs for details."),
          });
          writer.write({ type: "text-end", id });
        },
      }),
    });
  }
}
