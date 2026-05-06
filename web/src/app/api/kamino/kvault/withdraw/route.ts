import { NextRequest, NextResponse } from "next/server";

import { runKaminoKvaultWithdrawJob } from "@/server/agent/runRebalance";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const ownerPubkey = String(body.ownerPubkey ?? "");
    const kvault = String(body.kvault ?? "");
    const amount = typeof body.amount === "string" ? body.amount : "";

    if (!ownerPubkey) {
      return NextResponse.json({ status: "error", error: "ownerPubkey is required" }, { status: 400 });
    }
    if (!kvault) {
      return NextResponse.json({ status: "error", error: "kvault is required" }, { status: 400 });
    }
    if (!amount) {
      return NextResponse.json({ status: "error", error: "amount is required" }, { status: 400 });
    }

    const result = await runKaminoKvaultWithdrawJob({
      ownerPubkey,
      kvault,
      amount,
    });
    const httpStatus = result.status === "needs_whitelist" ? 428 : result.status === "error" ? 500 : 200;
    return NextResponse.json(result, { status: httpStatus });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[kamino-kvault-withdraw] failed", {
      message,
      stack: err instanceof Error ? err.stack : undefined,
    });
    return NextResponse.json({ status: "error", error: message }, { status: 500 });
  }
}
