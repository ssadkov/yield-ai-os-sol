import { mobileApi, mobileUsdcPlan } from "@/lib/mobileSafeApi.server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return mobileApi(() => mobileUsdcPlan(request, "withdraw")); }
