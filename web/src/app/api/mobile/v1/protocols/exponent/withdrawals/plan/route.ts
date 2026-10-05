import { mobileApi } from "@/lib/mobileSafeApi.server";
import { mobileExponentPlan } from "@/lib/mobileExponent.server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
export async function POST(request: Request) { return mobileApi(() => mobileExponentPlan(request, "withdraw")); }
