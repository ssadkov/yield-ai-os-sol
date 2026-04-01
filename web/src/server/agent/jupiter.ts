const BASE = "https://api.jup.ag";

export type JupiterFetchInit = RequestInit & { headers?: Record<string, string> };

export async function jupiterFetch<T>(
  apiKey: string,
  path: string,
  init?: JupiterFetchInit,
): Promise<T> {
  if (!apiKey) throw new Error("Missing JUPITER_API_KEY");
  const url = `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    ...init,
    headers: { "x-api-key": apiKey, ...init?.headers },
  });
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("Retry-After")) || 10;
    throw Object.assign(new Error("RATE_LIMITED"), { code: "RATE_LIMITED", retryAfter });
  }
  if (!res.ok) {
    const raw = await res.text();
    let body: unknown = raw || `HTTP_${res.status}`;
    try {
      body = raw ? JSON.parse(raw) : body;
    } catch {
      // keep text
    }
    throw Object.assign(new Error(`Jupiter ${res.status}`), { status: res.status, body });
  }
  return res.json() as Promise<T>;
}

