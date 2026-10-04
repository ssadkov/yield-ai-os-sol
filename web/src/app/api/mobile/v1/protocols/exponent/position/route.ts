import { mobileApi } from "@/lib/mobileSafeApi.server";
import { mobileExponentPosition } from "@/lib/mobileExponent.server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
export async function GET(request: Request) { return mobileApi(() => mobileExponentPosition(request)); }
