import { mobileApi, mobileConfig } from "@/lib/mobileSafeApi.server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() { return mobileApi(mobileConfig); }
