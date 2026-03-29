/**
 * Off-chain agent: hourly rebalance loop (rule-based allocation TBD).
 * Wire vault `execute_swap_cpi` + Jupiter Swap API in integration tasks.
 */
import { jupiterFetch } from "./jupiter.ts";
import { runSwapCli } from "./swap/cli.ts";

const apiKey = process.env.JUPITER_API_KEY ?? "";
const intervalMs = Number(process.env.REBALANCE_INTERVAL_MS ?? "3600000");

async function tick(): Promise<void> {
  const ts = new Date().toISOString();
  if (!apiKey) {
    console.warn(`[${ts}] JUPITER_API_KEY not set; skipping API probe`);
    return;
  }
  try {
    await jupiterFetch<{ message?: string }>(apiKey, "/health", { method: "GET" });
    console.log(`[${ts}] Jupiter API reachable`);
  } catch (e) {
    console.error(`[${ts}] Jupiter probe failed`, e);
  }
}

console.log(`Yield AI agent starting; interval ${intervalMs} ms`);

if (process.env.RUN_SWAP_CLI === "1") {
  await runSwapCli();
} else {
  await tick();
  setInterval(() => {
    void tick();
  }, intervalMs);
}
