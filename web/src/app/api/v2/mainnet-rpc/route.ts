import { NextResponse } from "next/server";
import { V2_MAINNET_RPC_URL, v2MainnetRpcHeaders } from "@/lib/v2MainnetRpc.server";

// The pilot proxy stays disabled until the protected Mainnet preview is configured.
const ALLOWED = new Set([
  "getGenesisHash", "getLatestBlockhash", "getBalance", "getFeeForMessage",
  "simulateTransaction", "sendTransaction", "getSignatureStatuses", "getBlockHeight",
  "getAccountInfo", "getTokenAccountsByOwner", "getTokenAccountBalance",
  "getMinimumBalanceForRentExemption",
]);
const MAX_REQUEST_BYTES = 256_000;

export async function POST(request: Request) {
  if (process.env.V2_MAINNET_RPC_PROXY_ENABLED !== "1" && process.env.NEXT_PUBLIC_V2_LAB_ENABLED !== "1") {
    return new NextResponse(null, { status: 404 });
  }
  const origin = request.headers.get("origin");
  if (origin) {
    let sameOrigin = false;
    try { sameOrigin = new URL(origin).origin === new URL(request.url).origin; } catch { /* reject */ }
    if (!sameOrigin) return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  if (Number(request.headers.get("content-length") || 0) > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "request too large" }, { status: 413 });
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "request too large" }, { status: 413 });
  }
  let body: unknown;
  try { body = JSON.parse(raw); } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const calls = Array.isArray(body) ? body : [body];
  if (!calls.length || calls.length > 10 || calls.some((call) => !call || typeof call !== "object"
    || !ALLOWED.has((call as { method?: string }).method ?? ""))) {
    return NextResponse.json({ error: "method not allowed" }, { status: 400 });
  }
  try {
    const upstream = await fetch(V2_MAINNET_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", ...v2MainnetRpcHeaders() },
      body: raw,
    });
    return new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return NextResponse.json({ error: "Mainnet RPC unavailable" }, { status: 502 });
  }
}
