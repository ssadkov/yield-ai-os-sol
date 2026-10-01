import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { parseEvmOwnerIntent, verifyEvmIntentSignature } from "@/lib/v2EvmDevnet";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const noStore = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
function upstream() {
  if (process.env.V2_EVM_RELAYER_ENABLED !== "true") throw new Error("disabled");
  const url = new URL(process.env.V2_EVM_RELAYER_URL || "http://127.0.0.1:3102");
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("invalid local relayer");
  const path = process.env.V2_EVM_RELAYER_SUBMIT_TOKEN_FILE;
  if (!path) throw new Error("missing submit credential");
  // This file contains only the scoped submit token. Never read the service config, admin token or signer.
  const token = readFileSync(path, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(token)) throw new Error("invalid submit credential");
  return { url: url.origin, token };
}
async function forward(path: string, expectedId: string, body?: unknown) {
  const { url, token } = upstream();
  const response = await fetch(url + path, { method: body ? "POST" : "GET", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(20000), cache: "no-store" });
  const result = await response.json() as { id?: string; state?: string; plan?: Record<string, unknown>; planHash?: string; signature?: string; slot?: number; actualCostLamports?: number; error?: string };
  if (!response.ok) return noStore({ error: "Relayer request rejected" }, response.status >= 500 ? 503 : 409);
  if (result.id !== expectedId || !/^0x[0-9a-f]{64}$/.test(result.id) || !["quoted","prepared","submitted","unknown","finalized","failed"].includes(result.state || "")) throw new Error("invalid response");
  if (!result.plan || result.plan.id !== expectedId || !result.planHash || !/^[0-9a-f]{64}$/.test(result.planHash)) throw new Error("invalid plan");
  const keys = ["id","action","cluster","payer","program","safe","nonce","deadline","source","amountRaw","recipientTokenAccount","recipientOwner","sourceBeforeRaw","sourceAfterRaw","recipientBeforeRaw","recipientAfterRaw","feeLamports","rentLamports","costLamports","computeUnits","deployedSha256","upgradeAuthority"];
  const plan = Object.fromEntries(keys.filter(key => Object.hasOwn(result.plan!, key)).map(key => [key, result.plan![key]]));
  if (Object.values(plan).some(value => value !== null && !["string","number"].includes(typeof value))) throw new Error("invalid plan value");
  return noStore({ id: result.id, state: result.state, plan, planHash: result.planHash,
    ...(typeof result.signature === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(result.signature) ? { signature: result.signature } : {}),
    ...(Number.isSafeInteger(result.slot) ? { slot: result.slot } : {}),
    ...(Number.isSafeInteger(result.actualCostLamports) ? { actualCostLamports: result.actualCostLamports } : {}) }, response.status);
}
export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return noStore({ error: "Same-origin request required" }, 403);
  if (!request.headers.get("content-type")?.startsWith("application/json")) return noStore({ error: "JSON required" }, 415);
  const reader = request.body?.getReader(); if (!reader) return noStore({ error: "Body required" }, 400);
  let bytes = 0; const chunks: Uint8Array[] = [];
  while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 4096) { await reader.cancel(); return noStore({ error: "Request too large" }, 413); } chunks.push(value); }
  let intent, digest;
  try { const raw = Buffer.concat(chunks).toString("utf8"); intent = parseEvmOwnerIntent(JSON.parse(raw)); digest = await verifyEvmIntentSignature(intent); }
  catch { return noStore({ error: "Invalid owner-signed intent" }, 400); }
  try { return await forward("/jobs", digest, intent); }
  catch { return noStore({ error: "Local relayer unavailable or disabled; use the operator fallback" }, 503); }
}
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !/^0x[0-9a-f]{64}$/.test(id)) return noStore({ error: "Valid job digest required" }, 400);
  try { return await forward("/jobs/" + id, id); }
  catch { return noStore({ error: "Local relayer unavailable or disabled" }, 503); }
}
