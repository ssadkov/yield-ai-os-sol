import { NextResponse } from "next/server";

export const revalidate = 3600; // Cache for 1 hour

export async function GET() {
  try {
    const yields: Record<string, { value: number; source: string }> = {};

    // Fetch ONRE/ONe yields
    try {
      const res = await fetch("https://core.api.onre.finance/data/live-apy", {
        next: { revalidate: 3600 },
      });
      if (res.ok) {
        const apyRaw = await res.text();
        const apy = parseFloat(apyRaw);
        if (!isNaN(apy)) {
          // The API returns a decimal (e.g. 0.1020 for 10.2%)
          yields["ONe"] = {
            value: apy * 100,
            source: "Onre API",
          };
          yields["Onyc"] = yields["ONe"]; // Setup alias just in case
        }
      }
    } catch (e) {
      console.warn("Failed to fetch Onre APY:", e);
    }

    // Future: add USDY, JitoSOL here

    return NextResponse.json(yields);
  } catch (error) {
    console.error("Global yield fetch error:", error);
    return NextResponse.json({});
  }
}
