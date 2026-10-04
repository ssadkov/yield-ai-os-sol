import { Connection } from "@solana/web3.js";
import { creationPlan, inspectSafe, MobileApiError, MOBILE_NETWORKS, requireCluster, solanaOwner, usdcTransferPlan, transactionStatus } from "./mobileSafe";
import { v2MainnetRpcHeaders, V2_MAINNET_RPC_URL } from "./v2MainnetRpc.server";

// Deployment selects one cluster. Requests cannot choose a program, mint, RPC or executor.
export function mobileSafeRuntime() {
  const cluster = process.env.V2_MOBILE_CLUSTER ?? "devnet";
  if (cluster !== "devnet" && cluster !== "mainnet") throw new MobileApiError("CONFIGURATION_ERROR", "Invalid mobile API cluster configuration", 503);
  const network = MOBILE_NETWORKS[cluster];
  const endpoint = cluster === "devnet" ? process.env.V2_DEVNET_RPC_URL ?? "https://api.devnet.solana.com" : V2_MAINNET_RPC_URL;
  return { network, connection: new Connection(endpoint, {
    commitment: "confirmed", disableRetryOnRateLimit: true,
    httpHeaders: cluster === "mainnet" ? v2MainnetRpcHeaders() : undefined,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }),
  }) };
}
export async function mobileApi(action: () => Promise<unknown>) {
  try {
    return Response.json(await action(), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const known = err instanceof MobileApiError;
    // RPC exception messages can contain private URLs/tokens. Only our typed errors are public.
    return Response.json({ error: {
      code: known ? err.code : "SERVICE_UNAVAILABLE",
      message: known ? err.message : "Unable to read the configured Solana RPC; retry later",
      ...(known && err.details ? { details: err.details } : {}),
    } }, { status: known ? err.status : 503, headers: { "Cache-Control": "no-store" } });
  }
}
export async function mobileConfig() {
  const { network, connection } = mobileSafeRuntime();
  if (await connection.getGenesisHash() !== network.genesis) throw new MobileApiError("RPC_CLUSTER_MISMATCH", "Configured RPC points to a different Solana cluster", 503);
  return { version: 1, network, supportedOwnerTypes: ["solana"], transactionSigning: "wallet", transactionSubmission: "wallet", rpcTransport: "/api/mobile/v1/rpc", amounts: "decimal strings, USDC six decimals; SOL costs in lamport strings", timeUnit: "unix_ms", capabilities: { safeCreation: true, createAndDeposit: true, transactionStatus: true, evmOwner: false, deposits: true, withdrawals: true, protocolDeposits: false, allocation: false, withdrawalScope: "idle_usdc", sponsoredGas: false, transactionSubmissionEnabled: mobileSubmissionEnabled(network) } };
}
export function mobileSubmissionEnabled(network: { cluster: string }) {
  return network.cluster === "devnet" || process.env.V2_MOBILE_MAINNET_SEND_ENABLED === "1";
}
export async function mobileTransactionStatus(request: Request, signature: string) {
  const url = new URL(request.url);
  const { network, connection } = mobileSafeRuntime();
  requireCluster(url.searchParams.get("cluster"), network);
  return transactionStatus(connection, network, signature, url.searchParams.get("lastValidBlockHeight"));
}
export async function mobileReadSafe(request: Request) {
  const url = new URL(request.url);
  const { network, connection } = mobileSafeRuntime();
  requireCluster(url.searchParams.get("cluster"), network);
  const owner = solanaOwner({ type: url.searchParams.get("ownerType"), address: url.searchParams.get("address") });
  return (await inspectSafe(connection, network, owner)).state;
}
export function parseCreationRequest(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new MobileApiError("INVALID_REQUEST", "Expected a JSON object");
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["owner", "cluster", "initialDepositUsdc"].includes(key))) throw new MobileApiError("INVALID_REQUEST", "Unexpected creation-plan field");
  return { owner: solanaOwner(value.owner), cluster: value.cluster, initialDepositUsdc: value.initialDepositUsdc };
}
export async function mobileCreationPlan(request: Request) {
  const input = parseCreationRequest(await planBody(request));
  const { network, connection } = mobileSafeRuntime();
  requireCluster(input.cluster, network);
  return creationPlan(connection, network, input.owner, input.initialDepositUsdc);
}
export async function mobileUsdcPlan(request: Request, kind: "deposit" | "withdraw") {
  const body = await planBody(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new MobileApiError("INVALID_REQUEST", "Expected a JSON object");
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["owner", "cluster", "amount"].includes(key))) throw new MobileApiError("INVALID_REQUEST", "Unexpected transfer-plan field");
  const owner = solanaOwner(value.owner);
  const { network, connection } = mobileSafeRuntime();
  requireCluster(value.cluster, network);
  return usdcTransferPlan(connection, network, owner, kind, value.amount);
}
async function planBody(request: Request): Promise<unknown> {
  // No signed payloads accepted and no sender key exists. This endpoint is read-only on chain.
  if (Number(request.headers.get("Content-Length") ?? 0) > 2048) throw new MobileApiError("INVALID_REQUEST", "Request body is too large", 413);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2048) {
          await reader.cancel();
          throw new MobileApiError("INVALID_REQUEST", "Request body is too large", 413);
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(raw); } catch { throw new MobileApiError("INVALID_REQUEST", "Expected valid JSON"); }
}
