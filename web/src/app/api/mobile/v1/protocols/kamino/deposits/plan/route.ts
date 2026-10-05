import { mobileApi, mobileKaminoDepositPlan } from "@/lib/mobileSafeApi.server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return mobileApi(() => mobileKaminoDepositPlan(request)); }

export const maxDuration = 60;
