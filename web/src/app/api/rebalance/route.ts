import { NextRequest, NextResponse } from "next/server";

const AGENT_API_URL = process.env.AGENT_API_URL || "http://localhost:3001";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { ownerPubkey } = body as { ownerPubkey?: string };

    if (!ownerPubkey) {
      return NextResponse.json(
        { status: "error", error: "ownerPubkey is required" },
        { status: 400 },
      );
    }

    const agentRes = await fetch(`${AGENT_API_URL}/rebalance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerPubkey }),
    });

    const data = await agentRes.json();
    return NextResponse.json(data, { status: agentRes.status });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { status: "error", error: `Agent unreachable: ${message}` },
      { status: 502 },
    );
  }
}
