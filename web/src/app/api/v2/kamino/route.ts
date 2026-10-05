import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { address, createDefaultRpcTransport, createNoopSigner, createSolanaRpcFromTransport } from "@solana/kit";
import { KaminoManager, KaminoVault, getCurrentLedgerInstant } from "@kamino-finance/klend-sdk";
import Decimal from "decimal.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { deriveVaultPda } from "@/lib/vault";
import { V2_MAINNET_RPC_URL, v2MainnetRpcHeaders } from "@/lib/v2MainnetRpc.server";

const KAMINO_API = "https://api.kamino.finance";
const KVAULT_PROGRAM = "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd";
const USDC_KVAULT = "91b1opzHNUQobfLZxGMNYT5qDRKoqV8FdsdQBmH4wBxy";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARES_MINT = "B9t9wg8r39Lxm2D9Gmqn2rJ5pVQQwjtGBfSsHAXSEnVe";
const WITHDRAW = "b712469c946da122";
const WITHDRAW_AVAILABLE = "1383709baadc2239";
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);

type ApiIx = { programAddress: string; data: string; accounts: { address: string; role: string }[] };

async function withdrawPlan(safe: PublicKey, shares: bigint) {
  const rpc = createSolanaRpcFromTransport(createDefaultRpcTransport({
    url: V2_MAINNET_RPC_URL,
    headers: v2MainnetRpcHeaders(),
  }));
  const vault = new KaminoVault(rpc, address(USDC_KVAULT), 400);
  const state = await vault.getState();
  if (state.tokenMint !== USDC_MINT || state.sharesMint !== SHARES_MINT) throw new Error("unexpected vault mints");
  const reserves = await new KaminoManager(rpc, 400).loadVaultReserves(state);
  const amount = new Decimal(shares.toString()).div(new Decimal(10).pow(state.sharesMintDecimals.toNumber()));
  const bundle = await vault.withdrawIxs(
    createNoopSigner(address(safe.toBase58())), amount, await getCurrentLedgerInstant(rpc), reserves,
    null, null,
  );
  // The Safe keeps shares in its ATA; it never stakes them in a Kamino farm.
  if (bundle.unstakeFromFarmIfNeededIxs.length) throw new Error("staked shares are unsupported");
  const safeUsdc = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), safe, true).toBase58();
  const safeShares = getAssociatedTokenAddressSync(new PublicKey(SHARES_MINT), safe, true).toBase58();
  const withdrawals = bundle.withdrawIxs
    .filter((ix) => ix.programAddress === KVAULT_PROGRAM)
    .map((ix) => {
      if (!ix.data) throw new Error("missing Kamino withdrawal data");
      const data = Buffer.from(ix.data);
      const discriminator = data.subarray(0, 8).toString("hex");
      if (data.length !== 16 || (discriminator !== WITHDRAW && discriminator !== WITHDRAW_AVAILABLE)
        || ix.accounts?.[0]?.address !== safe.toBase58() || ix.accounts?.[1]?.address !== USDC_KVAULT
        || ix.accounts?.[5]?.address !== safeUsdc || ix.accounts?.[7]?.address !== safeShares) {
        throw new Error("unexpected Kamino withdrawal layout");
      }
      return {
        shares: data.readBigUInt64LE(8).toString(), discriminator,
        accounts: ix.accounts.map((a) => ({ address: a.address, writable: (a.role & 1) !== 0 })),
      };
    });
  if (!withdrawals.length) throw new Error("no Kamino withdrawal instructions");
  const lookupTable = state.vaultLookupTable;
  return { safe: safe.toBase58(), withdrawals,
    lookupTables: lookupTable === PublicKey.default.toBase58() ? [] : [lookupTable] };
}

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
    try { return NextResponse.json(await withdrawPlan(safe, BigInt(rawShares))); }
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
