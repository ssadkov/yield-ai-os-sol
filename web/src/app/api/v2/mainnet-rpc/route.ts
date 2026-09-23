import { NextResponse } from "next/server";

// Lab-only proxy: the public mainnet RPC rejects browser origins (403).
const UPSTREAM = process.env.V2_MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
const ALLOWED = new Set([
  "getGenesisHash", "getLatestBlockhash", "getBalance", "getFeeForMessage",
  "simulateTransaction", "sendTransaction", "getSignatureStatuses", "getBlockHeight",
]);

export async function POST(request: Request) {
  if (process.env.NEXT_PUBLIC_V2_LAB_ENABLED !== "1") return new NextResponse(null, { status: 404 });
  const body = await request.json();
  const calls = Array.isArray(body) ? body : [body];
  if (calls.some((call) => !ALLOWED.has(call?.method))) {
    return NextResponse.json({ error: "method not allowed" }, { status: 400 });
  }
  const upstream = await fetch(UPSTREAM, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return new NextResponse(await upstream.text(), {
    status: upstream.status, headers: { "content-type": "application/json" },
  });
}
