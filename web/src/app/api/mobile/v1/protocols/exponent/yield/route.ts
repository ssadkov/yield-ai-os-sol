import { mobileApi } from "@/lib/mobileSafeApi.server";
import { mobileExponentYield } from "@/lib/mobileExponentYield.server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: Request) { return mobileApi(() => mobileExponentYield(request)); }
