import { NextResponse, type NextRequest } from "next/server";
import { streamText, tool, type Message } from "ai";
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

  return client(model);
}

async function getConnection(): Promise<Connection> {
  return new Connection(process.env.NEXT_PUBLIC_RPC_URL || RPC_URL, "confirmed");
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      messages?: Message[];
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
      messages,
      system: [
        "You are an AI portfolio assistant for a Solana vault.",
        "Your job: help the user understand their current portfolio, discuss strategy, and propose explicit actions.",
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
          parameters: z.object({
            ownerPubkey: z.string(),
          }),
          execute: async ({ ownerPubkey }) => {
            const connection = await getConnection();
            const owner = new PublicKey(ownerPubkey);

            const [vaultPda] = deriveVaultPda(owner);
            const vault = await fetchVaultAccount(connection, owner);

            const [wallet, vaultHoldings] = await Promise.all([
              fetchPortfolioAssets(connection, owner, { includeSol: true }),
              fetchPortfolioAssets(connection, vaultPda, { includeSol: false }),
            ]);

            return {
              ownerPubkey,
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
          parameters: z.object({
            ownerPubkey: z.string(),
            confirmed: z.boolean().default(false),
          }),
          execute: async ({ ownerPubkey, confirmed }) => {
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

            const agentBase =
              process.env.AGENT_API_URL || "http://localhost:3001";
            const res = await fetch(`${agentBase}/rebalance`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ownerPubkey, action: "rebalance" }),
            });
            const data = (await res.json()) as Record<string, unknown>;

            return { httpStatus: res.status, ...data };
          },
        }),

        convertAllToUsdc: tool({
          description:
            "Convert all vault holdings to USDC via the agent (pre-withdraw). Requires explicit confirmation.",
          parameters: z.object({
            ownerPubkey: z.string(),
            confirmed: z.boolean().default(false),
          }),
          execute: async ({ ownerPubkey, confirmed }) => {
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

            const agentBase =
              process.env.AGENT_API_URL || "http://localhost:3001";
            const res = await fetch(`${agentBase}/rebalance`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ownerPubkey, action: "convert_all" }),
            });
            const data = (await res.json()) as Record<string, unknown>;

            return { httpStatus: res.status, ...data };
          },
        }),

        getVaultHistory: tool({
          description:
            "Fetch a compact vault deposit/withdraw history summary for the owner's vault PDA.",
          parameters: z.object({
            ownerPubkey: z.string(),
            limit: z.number().int().min(1).max(50).default(20),
          }),
          execute: async ({ ownerPubkey, limit }) => {
            const connection = await getConnection();
            const owner = new PublicKey(ownerPubkey);
            const [vaultPda] = deriveVaultPda(owner);

            const data = await fetchVaultHistory(connection, PROGRAM_ID, vaultPda);
            const entries = data.entries.slice(-limit);

            return {
              ownerPubkey,
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

    const response = result.toDataStreamResponse({
      getErrorMessage: (err) =>
        err instanceof Error ? err.message : String(err),
    });

    return response;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

