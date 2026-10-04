import { mobileApi, mobileKaminoWithdrawalPlan } from "@/lib/mobileSafeApi.server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  return mobileApi(() => mobileKaminoWithdrawalPlan(request));
}

export const maxDuration = 60;
