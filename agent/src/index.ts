/**
 * Off-chain agent: HTTP server for rebalance requests + hourly health probe loop.
 * Set RUN_SWAP_CLI=1 to run the one-shot swap CLI instead.
 */
import "dotenv/config";
import { jupiterFetch } from "./jupiter.ts";
import { runSwapCli } from "./swap/cli.ts";
import { startServer } from "./server.ts";

const apiKey = process.env.JUPITER_API_KEY ?? "";
const intervalMs = Number(process.env.REBALANCE_INTERVAL_MS ?? "3600000");

async function tick(): Promise<void> {
  const ts = new Date().toISOString();
  if (!apiKey) {
    console.warn(`[${ts}] JUPITER_API_KEY not set; skipping API probe`);
    return;
  }
  try {
    const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    await jupiterFetch<Record<string, unknown>>(apiKey, `/price/v3?ids=${usdcMint}`, { method: "GET" });
    console.log(`[${ts}] Jupiter API reachable`);
  } catch (e) {
    console.error(`[${ts}] Jupiter probe failed`, e);
  }
}

console.log(`Yield AI agent starting; interval ${intervalMs} ms`);

if (process.env.RUN_SWAP_CLI === "1") {
  await runSwapCli();
} else {
  startServer();

  await tick();
  setInterval(() => {
    void tick();
  }, intervalMs);
}
