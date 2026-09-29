import { NextResponse } from "next/server";
import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { getAccount } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAddress, hashTypedData, isAddress, recoverTypedDataAddress, type Hex } from "viem";
import idlJson from "@/idl/yield_vault_evm_devnet.json";
import {
  EVM_DEVNET_GENESIS, EVM_DEVNET_PROGRAM, EVM_DEVNET_USDC_MINT,
  allocationTypedData, deriveEvmSafe, validateProbeAllocation,
  type EvmRelayIntent, type EvmSafeStatus,
} from "@/lib/v2EvmDevnet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const coder = new BorshAccountsCoder(idlJson as unknown as Idl);
const MAX_BODY_BYTES = 2_500;
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);

function devnetConnection() {
  const endpoint = process.env.V2_EVM_DEVNET_RPC_URL || "https://api.devnet.solana.com";
  const url = new URL(endpoint);
  if (url.protocol !== "https:") throw new Error("Devnet RPC must use HTTPS");
  return new Connection(endpoint, "confirmed");
}

async function readStatus(connection: Connection, ownerInput: string): Promise<EvmSafeStatus> {
  if (!isAddress(ownerInput)) throw new Error("Invalid EVM owner address");
  const { owner, ownerBytes, safe, ata } = deriveEvmSafe(ownerInput);
  if (await connection.getGenesisHash() !== EVM_DEVNET_GENESIS) throw new Error("RPC is not Solana Devnet");
  const info = await connection.getAccountInfo(safe, "confirmed");
  const status: EvmSafeStatus = {
    cluster: "devnet", program: EVM_DEVNET_PROGRAM.toBase58(), owner,
    safe: safe.toBase58(), ata: ata.toBase58(), exists: false,
    nonce: "0", allocationBps: Array(8).fill(0), usdcRaw: "0", rentPayer: null,
  };
  if (!info) return status;
  if (!info.owner.equals(EVM_DEVNET_PROGRAM)) throw new Error("Safe account has an unexpected owner");
  const vault = coder.decode("EvmVault", info.data) as {
    eth_address: number[]; rent_payer: PublicKey; nonce: { toString(): string }; allocation_bps: number[];
  };
  if (!Buffer.from(vault.eth_address).equals(Buffer.from(ownerBytes))) throw new Error("Safe owner mismatch");
  const token = await getAccount(connection, ata, "confirmed");
  if (!token.owner.equals(safe) || !token.mint.equals(EVM_DEVNET_USDC_MINT)) {
    throw new Error("Safe USDC account mismatch");
  }
  return {
    ...status, exists: true, nonce: vault.nonce.toString(),
    allocationBps: vault.allocation_bps, usdcRaw: token.amount.toString(),
    rentPayer: vault.rent_payer.toBase58(),
  };
}

function noStore<T>(value: T, status = 200) {
  return NextResponse.json(value, { status, headers: { "cache-control": "no-store" } });
}

function decimalU64(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,19})$/.test(value)) throw new Error(`Invalid ${field}`);
  const parsed = BigInt(value);
  if (parsed > U64_MAX) throw new Error(`Invalid ${field}`);
  return parsed;
}

export async function GET(request: Request) {
  const owner = new URL(request.url).searchParams.get("owner");
  if (!owner || !isAddress(owner)) return noStore({ error: "Valid EVM owner address required" }, 400);
  try { return noStore(await readStatus(devnetConnection(), owner)); }
  catch { return noStore({ error: "Devnet Safe state is unavailable or invalid" }, 503); }
}

/** Verifies an EVM signature and returns a canonical request for the operator. No Solana transaction is sent. */
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const requestUrl = new URL(request.url);
  const requestOrigin = `${requestUrl.protocol}//${request.headers.get("host") || requestUrl.host}`;
  if (!origin || origin !== requestOrigin) return noStore({ error: "Same-origin request required" }, 403);
  if (!request.headers.get("content-type")?.startsWith("application/json")) return noStore({ error: "JSON request required" }, 415);
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) return noStore({ error: "Request too large" }, 413);
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return noStore({ error: "Request too large" }, 413);
  let input: Record<string, unknown>;
  try { input = JSON.parse(raw) as Record<string, unknown>; }
  catch { return noStore({ error: "Invalid JSON" }, 400); }
  try {
    if (typeof input.owner !== "string" || !isAddress(input.owner) || typeof input.safe !== "string"
      || typeof input.signature !== "string" || !/^0x[\da-fA-F]{130}$/.test(input.signature)) {
      return noStore({ error: "Invalid owner, Safe or signature" }, 400);
    }
    const owner = getAddress(input.owner);
    const { safe } = deriveEvmSafe(owner);
    if (input.safe !== safe.toBase58()) return noStore({ error: "Safe address mismatch" }, 400);
    const allocationBps = validateProbeAllocation(input.allocationBps);
    const nonce = decimalU64(input.nonce, "nonce");
    const deadline = decimalU64(input.deadline, "deadline");
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (deadline <= now || deadline > now + BigInt(900)) return noStore({ error: "Signature deadline must be within 15 minutes" }, 400);
    const status = await readStatus(devnetConnection(), owner);
    if (nonce !== BigInt(status.nonce) + BigInt(1)) return noStore({ error: "Safe nonce changed; sign a fresh request" }, 409);
    const typedData = allocationTypedData(safe, allocationBps, nonce, deadline);
    const signature = input.signature as Hex;
    const recovered = await recoverTypedDataAddress({ ...typedData, signature });
    if (recovered !== owner) return noStore({ error: "Signature does not belong to the EVM owner" }, 400);
    const intent: EvmRelayIntent = { owner, safe: safe.toBase58(), allocationBps,
      nonce: nonce.toString(), deadline: deadline.toString(), signature };
    return noStore({ intent, digest: hashTypedData(typedData), relayMode: "operator", state: status });
  } catch (error) {
    if (error instanceof Error && /^(Invalid |The Devnet probe only supports)/.test(error.message)) {
      return noStore({ error: error.message }, 400);
    }
    return noStore({ error: "Could not verify the signed Devnet request" }, 503);
  }
}
