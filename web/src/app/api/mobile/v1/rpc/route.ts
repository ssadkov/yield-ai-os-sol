import { mobileApi, mobileSafeRuntime, mobileSubmissionEnabled } from "@/lib/mobileSafeApi.server";
import { MobileApiError } from "@/lib/mobileSafe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A small wallet RPC transport. Planning stays unsigned; this route has no signer.
// Forward only the wallet's signed transaction, never construct or retry a new transfer.
export async function POST(request: Request) {
  return mobileApi(async () => {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) throw new MobileApiError("INVALID_ORIGIN", "Cross-origin RPC requests are not enabled", 403);
    if (Number(request.headers.get("content-length") ?? 0) > 4096) throw new MobileApiError("INVALID_REQUEST", "RPC request too large", 413);
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (reader) while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) { await reader.cancel(); throw new MobileApiError("INVALID_REQUEST", "RPC request too large", 413); }
        chunks.push(value);
      }
    } finally { reader?.releaseLock(); }
    let call;
    try { call = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new MobileApiError("INVALID_REQUEST", "Expected an RPC object"); }
    if (!call || Array.isArray(call) || call.jsonrpc !== "2.0" || !["string", "number"].includes(typeof call.id) || !Array.isArray(call.params)) throw new MobileApiError("INVALID_REQUEST", "Expected a single JSON-RPC 2.0 request");
    if (!["getGenesisHash", "getBlockHeight", "sendTransaction"].includes(call.method)) throw new MobileApiError("RPC_METHOD_NOT_ALLOWED", "RPC method not allowed", 400);
    const { network, connection } = mobileSafeRuntime();
    if (call.method === "sendTransaction" && !mobileSubmissionEnabled(network)) throw new MobileApiError("MAINNET_SEND_DISABLED", "Mainnet submission is disabled for this deployment", 403);
    if (await connection.getGenesisHash() !== network.genesis) throw new MobileApiError("RPC_CLUSTER_MISMATCH", "RPC points to another cluster", 503);
    let result;
    if (call.method === "getGenesisHash" && call.params.length === 0) result = network.genesis;
    else if (call.method === "getBlockHeight" && call.params.length <= 1) result = await connection.getBlockHeight("confirmed");
    else if (call.method === "sendTransaction") {
      if (call.params.length > 2 || typeof call.params[0] !== "string" || call.params[0].length > 1644 || !/^[A-Za-z0-9+/]+={0,2}$/.test(call.params[0])) throw new MobileApiError("INVALID_REQUEST", "Expected one base64 signed transaction");
      const wire = Buffer.from(call.params[0], "base64");
      if (wire.length > 1232) throw new MobileApiError("INVALID_REQUEST", "Transaction exceeds packet size");
      // RPC verifies signatures and simulates. Caller cannot disable preflight or retries policy.
      result = await connection.sendRawTransaction(wire, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 2 });
    } else throw new MobileApiError("RPC_METHOD_NOT_ALLOWED", "RPC method not allowed", 400);
    return { jsonrpc: "2.0", id: call.id, result };
  });
}
