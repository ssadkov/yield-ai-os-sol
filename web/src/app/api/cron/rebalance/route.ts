import { NextRequest, NextResponse } from "next/server";
import { runRebalanceJob } from "@/server/agent/runRebalance";

export const runtime = "nodejs";

function unauthorized() {
  return NextResponse.json({ status: "error", error: "Unauthorized" }, { status: 401 });
}

export async function POST(req: NextRequest) {
  const expected = process.env.CRON_SECRET ?? "";
  if (!expected) {
    return NextResponse.json(
      { status: "error", error: "Missing CRON_SECRET" },
      { status: 500 },
    );
  }

  const provided = req.headers.get("x-cron-secret") ?? "";
  if (provided !== expected) return unauthorized();

  try {
    const body = await req.json();
    const { ownerPubkey, action } = body as {
      ownerPubkey?: string;
      action?: "rebalance" | "convert_all";
    };

    if (!ownerPubkey) {
      return NextResponse.json(
        { status: "error", error: "ownerPubkey is required" },
        { status: 400 },
      );
    }

    const result = await runRebalanceJob({ ownerPubkey, action });
    const httpStatus = result.status === "needs_whitelist" ? 428 : result.status === "error" ? 500 : 200;
    return NextResponse.json(result, { status: httpStatus });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ status: "error", error: message }, { status: 500 });
  }
}

