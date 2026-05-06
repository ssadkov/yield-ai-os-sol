export function formatWalletError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  const lower = `${name} ${message}`.toLowerCase();

  if (lower.includes("extension context invalidated")) {
    return "Phantom extension context was invalidated. Refresh this page, reconnect Phantom, then retry the allowlist update/deposit.";
  }

  return message;
}
