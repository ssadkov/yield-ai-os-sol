import "dotenv/config";
import { readFileSync } from "node:fs";
import express from "express";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { rebalance, convertAll } from "./rebalance/engine.ts";
import { deriveVaultPda } from "./swap/anchorIx.ts";

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function startServer(): void {
  const port = Number(process.env.PORT ?? "3001");
  const apiKey = process.env.JUPITER_API_KEY ?? "";
  const rpcUrl = process.env.RPC_URL ?? "";
  const vaultProgramIdStr = process.env.VAULT_PROGRAM_ID ?? "";
  const authorityKeypairPath = process.env.AUTHORITY_KEYPAIR ?? "";
  const slippageBps = Number(process.env.SLIPPAGE_BPS ?? "100");

  if (!apiKey || !rpcUrl || !vaultProgramIdStr || !authorityKeypairPath) {
    console.warn("[server] Missing env vars — HTTP rebalance endpoint will reject requests");
  }

  const app = express();
  app.use(express.json());

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/rebalance", async (req, res) => {
    const { ownerPubkey, action } = req.body as {
      ownerPubkey?: string;
      action?: "rebalance" | "convert_all";
    };

    if (!ownerPubkey) {
      res.status(400).json({ status: "error", error: "ownerPubkey is required" });
      return;
    }

    if (!apiKey || !rpcUrl || !vaultProgramIdStr || !authorityKeypairPath) {
      res.status(500).json({ status: "error", error: "Agent not configured (missing env vars)" });
      return;
    }

    try {
      const authority = loadKeypair(authorityKeypairPath);
      const vaultProgramId = new PublicKey(vaultProgramIdStr);
      const vaultOwner = new PublicKey(ownerPubkey);
      const connection = new Connection(rpcUrl, "confirmed");

      const vaultPda = deriveVaultPda(vaultProgramId, vaultOwner);
      const vaultInfo = await connection.getAccountInfo(vaultPda, "confirmed");
      if (!vaultInfo) {
        res.status(404).json({ status: "error", error: "Vault not found for this owner" });
        return;
      }

      const fn = action === "convert_all" ? convertAll : rebalance;
      console.log(`[server] ${action ?? "rebalance"} request for owner=${ownerPubkey}`);

      const result = await fn({
        connection,
        authority,
        vaultProgramId,
        vaultOwner,
        apiKey,
        rpcUrl,
        slippageBps,
      });

      const httpStatus = result.status === "needs_whitelist" ? 428 : 200;
      res.status(httpStatus).json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[server] Error:", message);
      res.status(500).json({ status: "error", error: message });
    }
  });

  app.listen(port, () => {
    console.log(`[server] Agent HTTP server listening on port ${port}`);
  });
}
