import { mobileApi, mobileTransactionStatus } from "@/lib/mobileSafeApi.server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ signature: string }> }) {
  return mobileApi(async () => mobileTransactionStatus(request, (await context.params).signature));
}
