import { NextRequest, NextResponse } from "next/server";

import { runIndividualSwapJob, runRebalanceJob } from "@/server/agent/runRebalance";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { ownerPubkey, action } = body as {
      ownerPubkey?: string;
      action?: "rebalance" | "convert_all" | "individual_swap";
    };

    if (!ownerPubkey) {
      return NextResponse.json(
        { status: "error", error: "ownerPubkey is required" },
        { status: 400 },
      );
    }

    if (action === "individual_swap") {
      const inputMint = String(body.inputMint ?? "");
      const outputMint = String(body.outputMint ?? "");
      const amount = String(body.amount ?? "");
      const amountUsd = Number(body.amountUsd ?? 0);
      if (!inputMint || !outputMint || !amount || BigInt(amount) === BigInt(0)) {
        return NextResponse.json(
          { status: "error", error: "inputMint, outputMint, and non-zero amount are required" },
          { status: 400 },
        );
      }
      const result = await runIndividualSwapJob({
        ownerPubkey,
        inputMint,
        outputMint,
        amount,
        amountUsd,
      });
      const httpStatus = result.status === "needs_whitelist" ? 428 : result.status === "error" ? 500 : 200;
      return NextResponse.json(result, { status: httpStatus });
    }

    const result = await runRebalanceJob({ ownerPubkey, action });
    const httpStatus = result.status === "needs_whitelist" ? 428 : result.status === "error" ? 500 : 200;
    return NextResponse.json(result, { status: httpStatus });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { status: "error", error: message },
      { status: 500 },
    );
  }
}
