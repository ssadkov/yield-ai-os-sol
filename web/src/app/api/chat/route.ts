import { NextResponse, type NextRequest } from "next/server";
import { KNOWLEDGE_BASE_RULES } from "@/config/chat-hints";
import {
  streamText,
  generateText,
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
import { ALL_TOKENS, CBBTC } from "@/server/agent/rebalance/tokens";

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

    const model = openRouterModel();

    const connection = await getConnection();
    const owner = ownerPubkey ? new PublicKey(ownerPubkey) : null;
    const vaultPda = owner ? deriveVaultPda(owner)[0] : null;

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

    // --- LLM-based confirmation detection ---
    // If the previous assistant message contained @@ACTION_PROPOSAL:xxx
    // and the user's latest message looks like it could be a confirmation,
    // use a cheap LLM call to classify intent.
    const prevAssistantText = (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === "assistant") return getUiText(messages[i]);
      }
      return "";
    })();

    const proposalMatch = prevAssistantText.match(/@@ACTION_PROPOSAL:(rebalance|convert_all)/);
    let inferredAction: "rebalance" | "convert_all" | null = null;

    if (proposalMatch && lastUserText && !body.clientAction) {
      // There was a pending action proposal. Classify the user's reply.
      const proposedAction = proposalMatch[1] as "rebalance" | "convert_all";
      try {
        const { text: classResult } = await generateText({
          model,
          system: "You are a yes/no classifier. The AI proposed an action and is waiting for user confirmation. Analyze the user's reply and respond with EXACTLY one word: YES or NO. YES means the user is confirming/agreeing. NO means anything else (question, refusal, new topic).",
          prompt: `Proposed action: ${proposedAction}\nUser reply: "${lastUserText}"\n\nIs the user confirming? Reply YES or NO:`,
        });
        if (classResult.trim().toUpperCase().startsWith("YES")) {
          inferredAction = proposedAction;
        }
      } catch (err) {
        console.error("[chat] LLM confirmation classifier failed:", err);
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
    const [walletSnap, vaultHoldingsSnap, vaultAccount] = owner && vaultPda
      ? await Promise.all([
        fetchPortfolioAssets(connection, owner, { includeSol: true }),
        fetchPortfolioAssets(connection, vaultPda, { includeSol: false }),
        fetchVaultAccount(connection, owner),
      ])
      : [null, null, null];

    const currentStrategyName = vaultAccount ? parseStrategy(vaultAccount.strategy) : null;

    const safeWalletSnap = walletSnap ?? { totalUsd: 0, assets: [] as NonNullable<typeof walletSnap>["assets"] };
    const safeVaultHoldingsSnap = vaultHoldingsSnap ?? { totalUsd: 0, assets: [] as NonNullable<typeof vaultHoldingsSnap>["assets"] };

    const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

    const walletUsdc = safeWalletSnap.assets.find((a) => a.mint === USDC_MINT)
      ?.balance ?? 0;
    const vaultUsdc = safeVaultHoldingsSnap.assets.find((a) => a.mint === USDC_MINT)
      ?.balance ?? 0;

    const pickTopAssets = (assets: typeof safeWalletSnap.assets, limit: number) =>
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

    const pickUnpricedAssets = (assets: typeof safeWalletSnap.assets, limit: number) =>
      assets
        .filter((a) => a.balance > 0 && a.usdPrice == null)
        .slice(0, limit)
        .map((a) => ({
          mint: a.mint,
          symbol: a.symbol,
          name: a.name,
          balance: a.balance,
        }));

    const portfolioContext = owner && vaultPda && walletSnap && vaultHoldingsSnap ? {
      ownerPubkey,
      vaultPda: vaultPda.toBase58(),
      wallet: {
        totalUsd: safeWalletSnap.totalUsd,
        assetCount: safeWalletSnap.assets.length,
        topAssets: pickTopAssets(safeWalletSnap.assets, 40),
        unpricedAssets: pickUnpricedAssets(safeWalletSnap.assets, 25),
      },
      vault: {
        totalUsd: safeVaultHoldingsSnap.totalUsd,
        assetCount: safeVaultHoldingsSnap.assets.length,
        topAssets: pickTopAssets(safeVaultHoldingsSnap.assets, 40),
        unpricedAssets: pickUnpricedAssets(safeVaultHoldingsSnap.assets, 25),
      },
    } : { status: "Wallet not connected or missing context" };

    // Deterministic token balance answers to avoid LLM hallucination.
    // Handles questions like: "сколько у меня ONyc?", "how much USDC in vault?"
    const tokenQueryMatch = lastUserText.match(
      /\b(?:сколько|how\s+much)\b[\s\S]{0,40}\b([A-Za-z][A-Za-z0-9]{1,14})\b/i
    );
    if (tokenQueryMatch) {
      const rawToken = tokenQueryMatch[1] ?? "";
      const token = rawToken.trim();
      const tokenUpper = token.toUpperCase();

      const findBySymbol = (assets: typeof safeWalletSnap.assets) =>
        assets.find((a) => (a.symbol ?? "").toUpperCase() === tokenUpper) ??
        assets.find((a) =>
          (a.name ?? "").toUpperCase().includes(tokenUpper)
        );

      const walletAsset = findBySymbol(safeWalletSnap.assets);
      const vaultAsset = findBySymbol(safeVaultHoldingsSnap.assets);

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
    if (body.clientAction === "snapshot" && owner && vaultPda) {
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
        const actionLabel = action === "rebalance" ? "Ребалансировка" : "Конвертация в USDC";
        try {
          if (!ownerPubkey) throw new Error("Wallet not connected");
          const data = await runRebalanceJob({ ownerPubkey, action });

          // Build a human-readable summary and return DIRECTLY (bypass LLM)
          let summary: string;
          if (data.status === "no_rebalance_needed") {
            summary = replyLang === "ru"
              ? `✅ ${actionLabel} выполнена. Свопов не потребовалось — текущие балансы уже соответствуют целевым пропорциям (или суммы слишком малы для свопов).`
              : `✅ ${actionLabel} completed. No swaps were needed — balances already match target allocations (or amounts are too small to swap).`;
          } else if (data.status === "success") {
            const swapLines = (data.swaps ?? []).map(
              (s) => `  • ${s.from.symbol} → ${s.to.symbol} ($${s.amountUsd.toFixed(2)})`
            );
            const sigLines = (data.signatures ?? []).map(
              (sig) => `  🔗 https://solscan.io/tx/${sig}`
            );
            summary = replyLang === "ru"
              ? `✅ ${actionLabel} выполнена!\n\nСвопы:\n${swapLines.join("\n")}\n\nТранзакции:\n${sigLines.join("\n")}`
              : `✅ ${actionLabel} completed!\n\nSwaps:\n${swapLines.join("\n")}\n\nTransactions:\n${sigLines.join("\n")}`;
          } else if (data.status === "needs_whitelist") {
            const missing = (data.missingPrograms ?? []).join(", ");
            summary = replyLang === "ru"
              ? `⚠️ Для выполнения ${actionLabel.toLowerCase()} нужно добавить программы в whitelist вашего vault:\n${missing}\n\nНажмите кнопку "Approve whitelist" выше.`
              : `⚠️ Your vault needs to whitelist these programs first:\n${missing}\n\nClick "Approve whitelist" above.`;
          } else {
            summary = replyLang === "ru"
              ? `❌ ${actionLabel} завершилась с ошибкой: ${data.error ?? "неизвестная ошибка"}`
              : `❌ ${actionLabel} failed: ${data.error ?? "unknown error"}`;
          }

          // Return direct stream, no LLM needed
          return createUIMessageStreamResponse({
            status: 200,
            stream: createUIMessageStream({
              execute({ writer }) {
                const id = "action-result";
                writer.write({ type: "text-start", id });
                writer.write({ type: "text-delta", id, delta: summary });
                writer.write({ type: "text-end", id });
              },
            }),
          });
        } catch (execErr: unknown) {
          const errMsg = execErr instanceof Error ? execErr.message : String(execErr);
          console.error("[chat] runRebalanceJob failed:", errMsg, execErr);
          const summary = replyLang === "ru"
            ? `❌ Ошибка выполнения: ${errMsg}`
            : `❌ Execution error: ${errMsg}`;
          return createUIMessageStreamResponse({
            status: 200,
            stream: createUIMessageStream({
              execute({ writer }) {
                const id = "action-error";
                writer.write({ type: "text-start", id });
                writer.write({ type: "text-delta", id, delta: summary });
                writer.write({ type: "text-end", id });
              },
            }),
          });
        }
      }
    }

    const result = streamText({
      model,
      messages: await convertToModelMessages(messages),
      system: [
        "You are an AI portfolio assistant for a Solana vault.",
        KNOWLEDGE_BASE_RULES,
        "Your job: help the user understand their current portfolio, discuss strategy, and propose explicit actions.",
        replyLang === "ru"
          ? "Language: reply in Russian."
          : "Language: reply in English.",
        "Always reply in the same language as the user's last message.",
        "Context:",
        `- ownerPubkey: ${ownerPubkey}`,
        `- vaultPda: ${vaultPda?.toBase58() ?? "N/A"}`,
        `- currentVaultStrategy: ${currentStrategyName ?? "None (No vault created yet)"}`,
        currentStrategyName ? "IMPORTANT: If the user asks to rebalance and a strategy is already set, do NOT ask for a choice. Compare current holdings with the target mix of this strategy and propose the @@ACTION_PROPOSAL:rebalance immediately." : "",
        `- walletUsdc: ${walletUsdc}`,
        `- vaultUsdc: ${vaultUsdc}`,
        `- walletTotalUsd: ${safeWalletSnap.totalUsd}`,
        `- vaultTotalUsd: ${safeVaultHoldingsSnap.totalUsd}`,
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
        "Token Context (explain why we hold these if asked):",
        JSON.stringify(
          ALL_TOKENS.map((t) => ({ symbol: t.symbol, description: t.description ?? "" })),
          null,
          2
        ),
        "Safety rules:",
        "- Never instruct the user to share private keys or seed phrases.",
        "- Never attempt withdrawals. Owner withdrawals must be done by the user outside this chat.",
        "Action proposal protocol:",
        "- When the user asks to rebalance or convert to USDC, do NOT execute immediately.",
        "  Instead, explain what you are about to do (which swaps, target allocations, approximate amounts based on the portfolio snapshot).",
        "  At the VERY END of your message, append the marker @@ACTION_PROPOSAL:rebalance or @@ACTION_PROPOSAL:convert_all on a new line.",
        "  The client will detect this marker and show the user a special action card with Confirm/Cancel buttons.",
        "  Example: 'I will rebalance your vault...\\n@@ACTION_PROPOSAL:rebalance'",
        "- You may also use the marker if the user agrees to an action you suggested.",
        "- NEVER call rebalanceVault or convertAllToUsdc tools directly. They are triggered via the action proposal protocol.",
        "Tool usage:",
        "- Use getPortfolioSnapshot to ground your analysis in current on-chain balances.",
        "When you return an execution recommendation, always explain what will happen on-chain and why.",
        "- IMPORTANT: If the user asks for a chart, price history, or performance of a specific token, you MUST call the showTokenChart tool immediately.",
        "- Default to the 1-month range if the user doesn't specify.",
        actionPreface ? `\nContext from the client action:\n${actionPreface}` : "",
        actionPreface ? "\nIMPORTANT: You MUST respond with a text explanation of what happened. Never produce an empty response. Summarize the action result for the user." : "",
      ].join("\n"),
      // @ts-ignore - maxSteps might be experimental or typed differently in this version
      maxSteps: 5,
      tools: {
        getStrategyExplainer: tool({
          description:
            "Explain strategy meaning, risk, and target mix. Uses authoritative strategy definitions.",
          inputSchema: z.object({
            strategy: z.enum(["Conservative", "Balanced", "Aggressive"]).optional(),
          }),
          execute: async ({ strategy }) => {
            if (!ownerPubkey) throw new Error("Wallet not connected");
            const picked = strategy ?? parseStrategy((await fetchVaultAccount(connection, new PublicKey(ownerPubkey)))!.strategy);
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
            const resolvedOwnerPubkey = toolOwnerPubkey ?? ownerPubkey;
            if (!resolvedOwnerPubkey) throw new Error("Wallet not connected");
            const connection = await getConnection();
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
            if (!resolvedOwnerPubkey) throw new Error("Wallet not connected");
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
            if (!resolvedOwnerPubkey) throw new Error("Wallet not connected");
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
            const resolvedOwnerPubkey = toolOwnerPubkey ?? ownerPubkey;
            if (!resolvedOwnerPubkey) throw new Error("Wallet not connected");
            const connection = await getConnection();
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

        showTokenChart: tool({
          description: "Display a historical price chart for a token.",
          inputSchema: z.object({
            symbol: z.string().describe("The token symbol (e.g. SOL, USDC, ONe, BTC, Bitcoin)"),
            mint: z.string().optional().describe("The token mint address if known"),
          }),
          execute: async ({ symbol, mint }) => {
            console.log(`[chat] showTokenChart tool called for symbol=${symbol}, mint=${mint}`);
            let resolvedMint = mint;
            let resolvedSymbol = symbol;
            
            const symUpper = symbol.toUpperCase();
            if (!resolvedMint) {
              const symLower = symbol.toLowerCase();
              const token = ALL_TOKENS.find(t => 
                t.symbol.toLowerCase() === symLower || 
                (t.symbol.toLowerCase() === "cbbtc" && (symLower === "btc" || symLower === "bitcoin")) ||
                (t.symbol.toLowerCase() === "oney" && (symLower === "one" || symLower === "onyc" || symLower === "ony"))
              );

              if (token) {
                resolvedMint = token.mint;
                resolvedSymbol = token.symbol;
              } else if (symUpper === "SOL") {
                resolvedMint = "So11111111111111111111111111111111111111112";
                resolvedSymbol = "SOL";
              } else if (symUpper === "BTC" || symUpper === "BITCOIN") {
                resolvedMint = CBBTC.mint;
                resolvedSymbol = "cbBTC";
              }
            }

            if (!resolvedMint) {
               return { error: `Could not find mint for symbol ${symbol}. Ask user for mint address.` };
            }

            return {
              symbol: resolvedSymbol,
              mint: resolvedMint,
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
