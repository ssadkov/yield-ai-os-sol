import { kaminoWithdrawalAccounts } from "@/lib/kaminoWithdrawal.server";
import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { deriveVaultPda } from "@/lib/vault";

const KAMINO_API = "https://api.kamino.finance";
const KVAULT_PROGRAM = "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd";
const USDC_KVAULT = "91b1opzHNUQobfLZxGMNYT5qDRKoqV8FdsdQBmH4wBxy";
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);

type ApiIx = { programAddress: string; data: string; accounts: { address: string; role: string }[] };

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const op = params.get("op");

  if (op === "metrics") {
    const res = await fetch(`${KAMINO_API}/kvaults/${USDC_KVAULT}/metrics`, { next: { revalidate: 60 } });
    if (!res.ok) return NextResponse.json({ error: `Kamino metrics ${res.status}` }, { status: 502 });
    const m = await res.json();
    const apy = Number(m.apy);
    const tokensPerShare = Number(m.tokensPerShare);
    const tokensAvailable = Number(m.tokensAvailable);
    if (!Number.isFinite(tokensPerShare) || tokensPerShare <= 0 || !Number.isFinite(tokensAvailable) || tokensAvailable < 0) {
      return NextResponse.json({ error: "invalid Kamino metrics" }, { status: 502 });
    }
    return NextResponse.json({ apy: Number.isFinite(apy) ? apy : null, tokensPerShare, tokensAvailable });
  }

  if (op !== "deposit" && op !== "withdraw") return NextResponse.json({ error: "op must be metrics|deposit|withdraw" }, { status: 400 });
  let owner: PublicKey;
  try { owner = new PublicKey(params.get("owner") ?? ""); } catch { return NextResponse.json({ error: "invalid owner" }, { status: 400 }); }
  const [safe] = deriveVaultPda(owner);

  if (op === "withdraw") {
    const rawShares = params.get("shares") ?? "";
    if (!/^[1-9]\d*$/.test(rawShares) || BigInt(rawShares) > U64_MAX) {
      return NextResponse.json({ error: "invalid shares" }, { status: 400 });
    }
    try { return NextResponse.json(await kaminoWithdrawalAccounts(safe, BigInt(rawShares))); }
    catch { return NextResponse.json({ error: "Could not build Kamino withdrawal from current vault state" }, { status: 502 }); }
  }

  const amount = params.get("amount") ?? "";
  if (!/^\d+(\.\d+)?$/.test(amount)) return NextResponse.json({ error: "invalid amount" }, { status: 400 });
  const res = await fetch(`${KAMINO_API}/ktx/kvault/deposit-instructions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: safe.toBase58(), kvault: USDC_KVAULT, amount }),
  });
  if (!res.ok) return NextResponse.json({ error: `Kamino deposit ${res.status}` }, { status: 502 });
  const payload = (await res.json()) as { instructions: ApiIx[]; lutsByAddress?: Record<string, string[]> };
  const kvault = payload.instructions.find((ix) => ix.programAddress === KVAULT_PROGRAM);
  if (!kvault || kvault.accounts[0]?.address !== safe.toBase58() || kvault.accounts[1]?.address !== USDC_KVAULT) {
    return NextResponse.json({ error: "unexpected Kamino instruction layout" }, { status: 502 });
  }
  return NextResponse.json({
    safe: safe.toBase58(),
    discriminator: Buffer.from(kvault.data, "base64").subarray(0, 8).toString("hex"),
    accounts: kvault.accounts.map((a) => ({ address: a.address, writable: a.role.includes("WRITABLE") })),
    lookupTables: Object.keys(payload.lutsByAddress ?? {}),
  });
}
