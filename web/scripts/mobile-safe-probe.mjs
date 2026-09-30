// Read-only probe. No keypairs/signing/send method; only state and unsigned simulation.
import { Connection, PublicKey } from "@solana/web3.js";
import { MOBILE_NETWORKS, creationPlan, usdcTransferPlan } from "../src/lib/mobileSafe.ts";

const cluster = process.env.V2_MOBILE_CLUSTER ?? "devnet";
if (cluster !== "devnet" && cluster !== "mainnet") throw new Error("Invalid cluster");
const rpc = cluster === "devnet" ? process.env.V2_DEVNET_RPC_URL : process.env.V2_MAINNET_RPC_URL;
if (!rpc) throw new Error("Set the private cluster RPC environment variable");
const owner = new PublicKey(process.env.MOBILE_PROBE_OWNER ?? "8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A");
try {
  const operation = process.env.MOBILE_PROBE_OPERATION ?? "create";
  const connection = new Connection(rpc, { commitment: "confirmed", disableRetryOnRateLimit: true });
  if (!["create", "deposit", "withdraw"].includes(operation)) throw new Error("Invalid probe operation");
  const plan = operation === "create" ? await creationPlan(connection, MOBILE_NETWORKS[cluster], owner) : await usdcTransferPlan(connection, MOBILE_NETWORKS[cluster], owner, operation, process.env.MOBILE_PROBE_AMOUNT ?? "1");
  console.log(JSON.stringify({ cluster, operation, status: plan.status, safe: plan.state.safe, owner: plan.state.owner, amount: plan.amount, destination: plan.destination, defaultExecutor: plan.state.defaultExecutor, cost: plan.cost, simulation: plan.simulation, steps: plan.steps.length }, null, 2));
} catch (err) {
  console.error(JSON.stringify({ code: err.code ?? "RPC_ERROR", message: err.code ? err.message : "RPC request failed (private URL omitted)" }));
  process.exitCode = 1;
}
