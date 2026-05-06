import { NextRequest, NextResponse } from "next/server";

import { runKaminoKvaultDepositJob } from "@/server/agent/runRebalance";

export const runtime = "nodejs";

const MIN_KVAULT_DEPOSIT_RAW = BigInt(1000);

function rawToUiAmount(raw: string, decimals: number): string {
  const value = BigInt(raw);
  const digits = value.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? "" : digits.slice(-decimals).replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

function rawToDecimalString(raw: string, decimals: number): string {
  const value = BigInt(raw);
  if (value <= BigInt(0)) throw new Error("amountRaw must be greater than zero");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("invalid decimals");
  }

  const negative = value < BigInt(0);
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? "" : digits.slice(-decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const ownerPubkey = String(body.ownerPubkey ?? "");
    const kvault = String(body.kvault ?? "");
    const amountRaw = body.amountRaw == null ? null : String(body.amountRaw);
    const decimals = Number(body.decimals ?? 6);
    if (amountRaw != null && BigInt(amountRaw) < MIN_KVAULT_DEPOSIT_RAW) {
      return NextResponse.json(
        {
          status: "error",
          error: `Kamino kVault minimum deposit is ${rawToUiAmount(MIN_KVAULT_DEPOSIT_RAW.toString(), decimals)} tokens. Vault balance selected: ${rawToUiAmount(amountRaw, decimals)}.`,
        },
        { status: 400 },
      );
    }
    const amount =
      typeof body.amount === "string" && body.amount.length > 0
        ? body.amount
        : rawToDecimalString(String(body.amountRaw ?? ""), decimals);

    if (!ownerPubkey) {
      return NextResponse.json({ status: "error", error: "ownerPubkey is required" }, { status: 400 });
    }
    if (!kvault) {
      return NextResponse.json({ status: "error", error: "kvault is required" }, { status: 400 });
    }

    const result = await runKaminoKvaultDepositJob({
      ownerPubkey,
      kvault,
      amount,
    });
    const httpStatus = result.status === "needs_whitelist" ? 428 : result.status === "error" ? 500 : 200;
    return NextResponse.json(result, { status: httpStatus });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[kamino-kvault-deposit] failed", {
      message,
      stack: err instanceof Error ? err.stack : undefined,
    });
    return NextResponse.json({ status: "error", error: message }, { status: 500 });
  }
}
