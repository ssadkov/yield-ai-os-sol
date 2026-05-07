import { NextRequest, NextResponse } from "next/server";

import { JUPITER_XSTOCKS_USDC_MARKETS } from "@/lib/jupiterBorrowMarkets";
import { runJupiterBorrowCollateralDepositJob } from "@/server/agent/runRebalance";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const ownerPubkey = String(body.ownerPubkey ?? "");
    const amountRaw = String(body.amountRaw ?? "");
    const vaultId = Number(body.vaultId ?? 0);
    const positionId = Number(body.positionId ?? 0);

    if (!ownerPubkey) {
      return NextResponse.json({ status: "error", error: "ownerPubkey is required" }, { status: 400 });
    }
    if (!Number.isInteger(vaultId) || vaultId <= 0) {
      return NextResponse.json({ status: "error", error: "valid vaultId is required" }, { status: 400 });
    }
    if (!/^\d+$/.test(amountRaw) || BigInt(amountRaw) <= BigInt(0)) {
      return NextResponse.json({ status: "error", error: "amountRaw must be greater than zero" }, { status: 400 });
    }
    if (!JUPITER_XSTOCKS_USDC_MARKETS.some((market) => market.vaultId === vaultId)) {
      return NextResponse.json(
        { status: "error", error: "vaultId is not enabled for xStocks / USDC collateral deposit" },
        { status: 400 },
      );
    }
    if (body.positionId != null && (!Number.isInteger(positionId) || positionId <= 0)) {
      return NextResponse.json(
        { status: "error", error: "positionId must be a positive integer when provided" },
        { status: 400 },
      );
    }

    const result = await runJupiterBorrowCollateralDepositJob({
      ownerPubkey,
      vaultId,
      amountRaw,
      positionId: positionId > 0 ? positionId : undefined,
    });
    const httpStatus = result.status === "needs_whitelist" ? 428 : result.status === "error" ? 500 : 200;
    return NextResponse.json(result, { status: httpStatus });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[jupiter-borrow-deposit-collateral] failed", {
      message,
      stack: err instanceof Error ? err.stack : undefined,
    });
    return NextResponse.json({ status: "error", error: message }, { status: 500 });
  }
}
