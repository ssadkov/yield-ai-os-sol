import { NextRequest, NextResponse } from "next/server";

const JUPITER_API_KEY = process.env.JUPITER_API_KEY || "";
const BASE = "https://api.jup.ag";

export async function GET(req: NextRequest) {
  const ids = req.nextUrl.searchParams.get("ids");
  if (!ids) {
    return NextResponse.json({ error: "ids parameter required" }, { status: 400 });
  }

  try {
    const headers: Record<string, string> = { "x-api-key": JUPITER_API_KEY };

    const res = await fetch(`${BASE}/price/v3?ids=${ids}`, { headers });
    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json({ error: text }, { status: res.status });
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Failed to fetch prices" }, { status: 502 });
  }
}
