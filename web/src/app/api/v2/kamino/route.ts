import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { deriveVaultPda } from "@/lib/vault";

// Server-side proxy to the Kamino API: kVault metrics and the account list of a kVault
// deposit/withdraw for a Safe. The Safe program builds the instruction data itself; only
// the accounts come from here, and the program re-checks every one it relies on.
const KAMINO_API = "https://api.kamino.finance";
const KVAULT_PROGRAM = "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd";
const USDC_KVAULT = "91b1opzHNUQobfLZxGMNYT5qDRKoqV8FdsdQBmH4wBxy";

type ApiIx = { programAddress: string; data: string; accounts: { address: string; role: string }[] };

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const op = params.get("op");

  if (op === "metrics") {
    const res = await fetch(`${KAMINO_API}/kvaults/${USDC_KVAULT}/metrics`, { next: { revalidate: 60 } });
    if (!res.ok) return NextResponse.json({ error: `Kamino metrics ${res.status}` }, { status: 502 });
    const m = await res.json();
    return NextResponse.json({ apy: Number(m.apy), tokensPerShare: Number(m.tokensPerShare), tokensAvailable: Number(m.tokensAvailable) });
  }

  if (op !== "deposit" && op !== "withdraw") return NextResponse.json({ error: "op must be metrics|deposit|withdraw" }, { status: 400 });
  let owner: PublicKey;
  try { owner = new PublicKey(params.get("owner") ?? ""); } catch { return NextResponse.json({ error: "invalid owner" }, { status: 400 }); }
  const amount = params.get("amount") ?? "";
  if (!/^\d+(\.\d+)?$/.test(amount)) return NextResponse.json({ error: "invalid amount" }, { status: 400 });

  const [safe] = deriveVaultPda(owner);
  const res = await fetch(`${KAMINO_API}/ktx/kvault/${op}-instructions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: safe.toBase58(), kvault: USDC_KVAULT, amount }),
  });
  if (!res.ok) return NextResponse.json({ error: `Kamino ${op} ${res.status}: ${(await res.text()).slice(0, 300)}` }, { status: 502 });
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
