import { NextRequest, NextResponse } from "next/server";

const JUPITER_API_KEY = process.env.JUPITER_API_KEY || "";
const BASE = "https://api.jup.ag";

export async function GET(req: NextRequest) {
  const ids = req.nextUrl.searchParams.get("ids");
  if (!ids) {
    return NextResponse.json({ error: "ids parameter required" }, { status: 400 });
  }

  const mints = ids.split(",").map((s) => s.trim()).filter(Boolean);
  if (mints.length === 0) {
    return NextResponse.json({ data: {} });
  }

  const headers: Record<string, string> = { "x-api-key": JUPITER_API_KEY };
  const result: Record<string, unknown> = {};

  const batches: string[][] = [];
  for (let i = 0; i < mints.length; i += 20) {
    batches.push(mints.slice(i, i + 20));
  }

  await Promise.all(
    batches.map(async (batch) => {
      await Promise.all(
        batch.map(async (mint) => {
          try {
            const res = await fetch(
              `${BASE}/tokens/v2/search?query=${mint}`,
              { headers }
            );
            if (!res.ok) return;
            const arr = await res.json();
            if (Array.isArray(arr)) {
              const match = arr.find(
                (t: Record<string, unknown>) => t.id === mint || t.address === mint
              );
              if (match) {
                result[mint] = match;
              }
            }
          } catch {
            // skip
          }
        })
      );
    })
  );

  return NextResponse.json({ data: result });
}
