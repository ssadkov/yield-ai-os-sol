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
    const executionEnabled = body.executionEnabled === true;

    const connection = await getConnection();
    const owner = new PublicKey(ownerPubkey);
    const [vaultPda] = deriveVaultPda(owner);

    // Always provide a compact, fresh snapshot so the assistant can answer questions
    // like "how much USDC do I have?" without needing an explicit tool call.
    const [walletSnap, vaultHoldingsSnap] = await Promise.all([
      fetchPortfolioAssets(connection, owner, { includeSol: true }),
      fetchPortfolioAssets(connection, vaultPda, { includeSol: false }),
    ]);

    const walletUsdc =
      walletSnap.assets.find((a) => a.mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
        ?.balance ?? 0;
    const vaultUsdc =
      vaultHoldingsSnap.assets.find((a) => a.mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
        ?.balance ?? 0;

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
        const agentBase = process.env.AGENT_API_URL || "http://localhost:3001";
        const action =
          body.clientAction === "rebalance" ? "rebalance" : "convert_all";
        const res = await fetch(`${agentBase}/rebalance`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ownerPubkey, action }),
        });
        const data = (await res.json()) as Record<string, unknown>;
        actionPreface =
          `Client executed action=${action} (confirmed).\n` +
          JSON.stringify({ httpStatus: res.status, ...data }, null, 2);
      }
    }

    const result = streamText({
      model,
      messages: await convertToModelMessages(messages),
      system: [
        "You are an AI portfolio assistant for a Solana vault.",
        "Your job: help the user understand their current portfolio, discuss strategy, and propose explicit actions.",
        "Context:",
        `- ownerPubkey: ${ownerPubkey}`,
        `- vaultPda: ${vaultPda.toBase58()}`,
        `- walletUsdc: ${walletUsdc}`,
        `- vaultUsdc: ${vaultUsdc}`,
        `- walletTotalUsd: ${walletSnap.totalUsd}`,
        `- vaultTotalUsd: ${vaultHoldingsSnap.totalUsd}`,
        "Safety rules:",
        "- Never instruct the user to share private keys or seed phrases.",
        "- Never attempt withdrawals. Owner withdrawals must be done by the user outside this chat.",
        "- Only trigger execution tools (rebalance/convert) when the user explicitly confirms.",
        "Tool usage:",
        "- Use getPortfolioSnapshot to ground your analysis in current on-chain balances.",
        "- If execution is requested, call the relevant tool with confirmed=true.",
        "When you return an execution recommendation, always explain what will happen on-chain and why.",
        "Client action protocol:",
        "- If the system prompt contains a section 'Context from the client action' with JSON, you MUST include a final line in your answer:",
        "  @@CLIENT_ACTION_RESULT <the exact same JSON, minified or pretty is OK, but must be valid JSON>",
        "- Do not fabricate fields in that JSON; echo it as given.",
        actionPreface ? `\nContext from the client action:\n${actionPreface}` : "",
      ].join("\n"),
      tools: {
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
            const agentBase =
              process.env.AGENT_API_URL || "http://localhost:3001";
            const res = await fetch(`${agentBase}/rebalance`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ownerPubkey: resolvedOwnerPubkey,
                action: "rebalance",
              }),
            });
            const data = (await res.json()) as Record<string, unknown>;

            return { httpStatus: res.status, ...data };
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
            const agentBase =
              process.env.AGENT_API_URL || "http://localhost:3001";
            const res = await fetch(`${agentBase}/rebalance`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ownerPubkey: resolvedOwnerPubkey,
                action: "convert_all",
              }),
            });
            const data = (await res.json()) as Record<string, unknown>;

            return { httpStatus: res.status, ...data };
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

