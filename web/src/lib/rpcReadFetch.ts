/** Shared per-instance pacing for the pilot RPC budget. Never retry signed submissions here. */
export function createRpcReadFetch(fetchImpl: typeof fetch = fetch, options: { intervalMs?: number; timeoutMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): typeof fetch {
  const interval = options.intervalMs ?? 200;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let queue = Promise.resolve();
  let nextStart = 0;
  return async (input, init) => {
    let method: unknown;
    try { method = JSON.parse(typeof init?.body === 'string' ? init.body : '').method; } catch { /* Unrecognized calls are never retried. */ }
    const read = typeof method === 'string' && (method.startsWith('get') || method === 'simulateTransaction');
    for (let attempt = 0; ; attempt++) {
      if (read) {
        const slot = queue.then(async () => {
          const wait = Math.max(0, nextStart - now());
          if (wait) await sleep(wait);
          nextStart = now() + interval;
        });
        queue = slot.catch(() => {});
        await slot;
      }
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      signal.throwIfAborted();
      const response = await fetchImpl(input, { ...init, signal });
      if (!read || response.status !== 429 || attempt >= 2) return response;
      const header = response.headers.get('retry-after');
      const delay = header === null ? 1000 * (attempt + 1) : /^\d+(\.\d+)?$/.test(header)
        ? Number(header) * 1000 : Date.parse(header) - now();
      // A long provider cooldown exceeds our request budget. Return it instead of retrying early.
      if (!Number.isFinite(delay) || delay > 3000) return response;
      await response.body?.cancel();
      await sleep(Math.max(0, delay));
    }
  };
}
// Shared across Connections in one function instance. Provider-wide quotas still apply across instances.
export const pacedRpcReadFetch = createRpcReadFetch();
