import { NextRequest, NextResponse } from "next/server";
import { fetchJupiterLendMarkets } from "@/server/agent/protocols/jupiterLendMarkets";

export const runtime = "nodejs";
export const revalidate = 300;

export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const focusOnly = params.get("focus") === "1" || params.get("focusOnly") === "1";
    const maxVaultsRaw = Number(params.get("maxVaults"));
    const maxVaults = Number.isFinite(maxVaultsRaw) && maxVaultsRaw > 0 ? maxVaultsRaw : undefined;
    const vaultIds = params.get("ids")
      ?.split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value > 0);

    const result = await fetchJupiterLendMarkets({ focusOnly, maxVaults, vaultIds });
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        success: false,
        error: message,
        data: [],
        count: 0,
      },
      { status: 500 },
    );
  }
}
