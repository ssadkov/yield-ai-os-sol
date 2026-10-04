/** Server-only configuration for the v2 Mainnet RPC. Never import this from a client component. */
export const V2_MAINNET_RPC_URL =
  process.env.V2_MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";

export function v2MainnetRpcHeaders(): { Authorization?: string } {
  const endpoint = new URL(V2_MAINNET_RPC_URL);
  const isSupanode = endpoint.hostname === "fra.sol.supanode.xyz";
  const token = process.env.SUPANODE_TOKEN?.trim();

  if (isSupanode && !token) throw new Error("SUPANODE_TOKEN is required for the Supanode RPC");
  if (token && !isSupanode) throw new Error("SUPANODE_TOKEN may only be sent to the configured Supanode host");
  if (token && endpoint.protocol !== "https:") throw new Error("Authenticated RPC requires HTTPS");
  return token ? { Authorization: `Bearer ${token}` } : {};
}
