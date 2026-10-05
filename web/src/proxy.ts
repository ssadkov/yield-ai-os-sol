import { NextResponse, type NextRequest } from "next/server";
import { mobilePublicPath, mobileOriginAllowed } from "./lib/mobilePublicAccess";
export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (process.env.V2_MOBILE_API_ONLY === "1" && !mobilePublicPath(path)) return new NextResponse("Not found", { status: 404 });
  if (process.env.V2_MOBILE_API_ONLY === "1" && path === "/") return NextResponse.redirect(new URL("/v2/mobile", request.url));
  if (!path.startsWith("/api/mobile/v1/")) return NextResponse.next();
  const origin = request.headers.get("origin");
  if (!mobileOriginAllowed(origin, request.nextUrl.origin, process.env.V2_MOBILE_ALLOWED_ORIGINS ?? "")) return NextResponse.json({ error: { code: "INVALID_ORIGIN", message: "Origin is not enabled" } }, { status: 403 });
  const response = request.method === "OPTIONS" ? new NextResponse(null, { status: 204 }) : NextResponse.next();
  if (origin) response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Vary", "Origin");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  response.headers.set("Access-Control-Max-Age", "600");
  return response;
}
export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
