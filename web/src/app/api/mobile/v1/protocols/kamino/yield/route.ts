import { mobileApi, mobileKaminoYield } from "@/lib/mobileSafeApi.server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return mobileApi(() => mobileKaminoYield(request)); }
