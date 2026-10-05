export function mobilePublicPath(pathname: string) {
  return pathname === "/" || pathname === "/v2/mobile" || pathname.startsWith("/api/mobile/v1/") || pathname.startsWith("/_next/") || pathname === "/favicon.ico";
}
export function mobileOriginAllowed(origin: string | null, requestOrigin: string, configured: string) {
  return !origin || origin === requestOrigin || configured.split(",").map(s => s.trim()).filter(Boolean).includes(origin);
}
