import { createExponentYieldReader, EXPONENT_YIELD_REFERENCE_RAW, EXPONENT_YIELD_MARKET } from "./exponentYield";
import { MobileApiError, requireCluster } from "./mobileSafe";
import { mobileSafeRuntime } from "./mobileSafeApi.server";
import { quote } from "../server/exponent/adapter";

const readExponentYield = createExponentYieldReader(async () => {
  const { network, connection } = mobileSafeRuntime();
  if (await connection.getGenesisHash() !== network.genesis)
    throw Error("Configured RPC cluster mismatch");
  // No owner, authority, Safe, position lookup or transaction construction.
  return (await quote(connection, {
    market: EXPONENT_YIELD_MARKET, action: "buy", asset: "USDC",
    amount: EXPONENT_YIELD_REFERENCE_RAW, slippageBps: 50,
  })).public;
});
export async function mobileExponentYield(request: Request) {
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some(key => key !== "cluster")
    || url.searchParams.getAll("cluster").length !== 1)
    throw new MobileApiError("INVALID_REQUEST", "Use only cluster=mainnet");
  const { network } = mobileSafeRuntime();
  requireCluster(url.searchParams.get("cluster"), network);
  if (network.cluster !== "mainnet")
    throw new MobileApiError("UNSUPPORTED_CLUSTER", "Exponent yield is available on Mainnet only", 422);
  try { return await readExponentYield(); }
  catch {
    throw new MobileApiError("YIELD_UNAVAILABLE", "Exponent yield is temporarily unavailable; no fresh rate issued", 503,
      { status: "unavailable", apyRatio: null, aprRatio: null });
  }
}
