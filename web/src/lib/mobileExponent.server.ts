import { ExponentRouteUnavailable } from './exponentOrca';
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { ACCOUNT_SIZE, TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { createHash } from "node:crypto";
import { MobileApiError, inspectSafe, requireCluster, usdcAmount } from "./mobileSafe";
import { mobileSafeRuntime, planBody } from "./mobileSafeApi.server";
import { protocolRequest, selectPositionAmount } from "./mobileProtocolRequest";
import { EXPONENT, EXPONENT_MARKET, tokenAddress, positionAddress, decodePosition } from "./exponentV2";
import { unsignedSetup, unsignedTransaction, policyAddress } from "../server/exponent/transactions";
import { marketInfo } from "../server/exponent/adapter";

async function checkedContext(owner: PublicKey, cluster: unknown) {
  const { connection, network } = mobileSafeRuntime();
  requireCluster(cluster, network);
  if (network.cluster !== "mainnet") throw new MobileApiError("UNSUPPORTED_CLUSTER", "Exponent market is available on Mainnet only", 422);
  const inspected = await inspectSafe(connection, network, owner);
  if (!inspected.state.exists) throw new MobileApiError("SAFE_NOT_CREATED", "Create and confirm your Safe first", 409);
  const positionKey = positionAddress(inspected.addresses.safe);
  const positionInfo = await connection.getAccountInfo(positionKey, "confirmed");
  let position = null;
  if (positionInfo) {
    if (!positionInfo.owner.equals(inspected.addresses.program)) throw new MobileApiError("INVALID_ACCOUNT", "Foreign Exponent position", 422);
    position = decodePosition(positionInfo.data, positionKey);
    if (position.safe !== inspected.state.safe) throw new MobileApiError("INVALID_ACCOUNT", "Position does not match Safe", 422);
  }
  const balances: Record<string, string> = {};
  for (const [name, mint] of Object.entries({ pt: EXPONENT.pt, onyc: EXPONENT.onyc, sy: EXPONENT.sy, yt: EXPONENT.yt })) {
    const address = tokenAddress(inspected.addresses.safe, mint);
    const info = await connection.getAccountInfo(address, "confirmed");
    if (!info) { balances[name] = "0"; continue; }
    const account = unpackAccount(address, info, TOKEN_PROGRAM_ID);
    if (!account.owner.equals(inspected.addresses.safe) || account.mint.toBase58() !== mint || account.isFrozen || account.delegate || account.closeAuthority) throw new MobileApiError("INVALID_ACCOUNT", "Invalid Exponent custody account", 422);
    balances[name] = String(account.amount);
  }
  return { connection, network, inspected, owner, position, balances };
}
async function envelope(context: Awaited<ReturnType<typeof checkedContext>>, built: Awaited<ReturnType<typeof unsignedSetup>> | Awaited<ReturnType<typeof unsignedTransaction>>, kind: string, rent = 0) {
  const tx = VersionedTransaction.deserialize(Buffer.from(built.unsignedTransaction, "base64"));
  if (tx.message.header.numRequiredSignatures !== 1 || !tx.message.staticAccountKeys[0].equals(context.owner) || tx.signatures.some(s => s.some(b => b !== 0))) throw new MobileApiError("INVALID_TRANSACTION", "Expected one unsigned owner transaction", 422);
  if (built.networkFeeLamports === null) throw new MobileApiError("BLOCKHASH_UNAVAILABLE", "Refresh the transaction plan", 409);
  const fee = built.networkFeeLamports;
  if (BigInt(context.inspected.state.walletSolLamports) < BigInt(rent + fee)) throw new MobileApiError("INSUFFICIENT_SOL", "Owner needs SOL for rent and network fee", 422, { requiredLamports: String(rent + fee) });
  if (!built.executionReady) throw new MobileApiError("EXPONENT_UNAVAILABLE", "Reviewed deployment or transaction simulation is unavailable; no signing payload issued", 422);
  return { status: "ready", scope: "exponent_pt", state: context.inspected.state, market: EXPONENT_MARKET,
    blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight,
    planId: createHash("sha256").update(context.network.genesis).update(built.unsignedTransaction).digest("hex"), createdAt: Date.now(),
    cost: { networkFeeLamports: String(fee), rentLamports: String(rent), totalLamports: String(rent + fee), maximumWalletDebitLamports: String(rent + fee), feePayer: context.owner.toBase58(), walletSolLamports: context.inspected.state.walletSolLamports },
    simulation: { slot: built.simulation.slot, unitsConsumed: built.simulation.unitsConsumed },
    steps: [{ id: kind, kind, title: kind, transaction: built.unsignedTransaction, transactionVersion: 0, requiredSigners: [context.owner.toBase58()] }],
    ...( "quote" in built ? { quote: built.quote, quoteExpiresAtUnixSeconds: built.quote.expiresAt, minimumOutputRaw: built.minimumOutputRaw } : {}),
  };
}
export async function mobileExponentPosition(request: Request) {
  const url = new URL(request.url);
  const { owner } = protocolRequest({ owner: { type: url.searchParams.get("ownerType"), address: url.searchParams.get("address") } }, []);
  const c = await checkedContext(owner, url.searchParams.get("cluster"));
  return { state: c.inspected.state, market: EXPONENT_MARKET, position: c.position, balancesRaw: c.balances, setupRequired: !c.position, marketInfo: await marketInfo(c.connection) };
}
export async function mobileExponentPlan(request: Request, kind: "deposit" | "withdraw") {
  try {return await exponentPlan(request,kind);}
  catch(e){if(e instanceof ExponentRouteUnavailable)throw new MobileApiError(e.code,e.message,422);throw e;}
}
async function exponentPlan(request: Request, kind: "deposit" | "withdraw") {
  const { value, owner } = protocolRequest(await planBody(request), kind === "deposit" ? ["phase", "amount", "source", "market", "slippageBps"] : ["shares", "percent", "market", "slippageBps"]);
  if (value.market !== undefined && value.market !== EXPONENT_MARKET) throw new MobileApiError("INVALID_REQUEST", "Unsupported market");
  if (value.slippageBps !== undefined && (!Number.isInteger(value.slippageBps) || Number(value.slippageBps) < 2 || Number(value.slippageBps) > 100)) throw new MobileApiError("INVALID_REQUEST", "slippageBps must be 2..100");
  const c = await checkedContext(owner, value.cluster);
  if (kind === "deposit" && value.phase === "setup") {
    if (value.amount !== undefined || value.source !== undefined) throw new MobileApiError("INVALID_REQUEST", "Setup cannot move funds");
    const built = await unsignedSetup(c.connection, owner.toBase58(), 500, Number(value.slippageBps ?? 50));
    const cfg = await c.connection.getAccountInfo(policyAddress("config"), "confirmed");
    if (!cfg) throw new MobileApiError("CONFIG_UNAVAILABLE", "Safe config unavailable", 503);
    const treasury = new PublicKey(cfg.data.subarray(40,72));
    const addresses = [...[EXPONENT.usdc, EXPONENT.onyc, EXPONENT.pt, EXPONENT.sy, EXPONENT.yt].map(m => tokenAddress(c.inspected.addresses.safe,m)),tokenAddress(owner,EXPONENT.usdc),tokenAddress(owner,EXPONENT.onyc),tokenAddress(treasury,EXPONENT.usdc)];
    const infos = await c.connection.getMultipleAccountsInfo(addresses, "confirmed");
    const ataRent = await c.connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
    let rent = infos.reduce((sum, info) => sum + ((!info || info.owner.toBase58() === "11111111111111111111111111111111") ? Math.max(0, ataRent - (info?.lamports ?? 0)) : 0), 0);
    if (!c.position) rent += await c.connection.getMinimumBalanceForRentExemption(288);
    return { ...await envelope(c, built, "exponent_setup", rent), phase: "setup", next: { endpoint: "/api/mobile/v1/protocols/exponent/deposits/plan", phase: "invest" } };
  }
  if (!c.position) return { status: "setup_required", state: c.inspected.state, steps: [], next: { endpoint: "/api/mobile/v1/protocols/exponent/deposits/plan", phase: "setup" } };
  let amount: bigint;
  if (kind === "deposit") {
    if (value.phase !== undefined && value.phase !== "invest") throw new MobileApiError("INVALID_REQUEST", "phase must be setup or invest");
    if (value.source !== "safe" && value.source !== "wallet") throw new MobileApiError("INVALID_REQUEST", "source must be safe or wallet");
    amount = usdcAmount(value.amount);
    if (amount > (value.source === "wallet" ? c.inspected.walletUsdc : c.inspected.balanceUsdc)) throw new MobileApiError("INSUFFICIENT_USDC", "Insufficient source USDC", 422);
  } else {
    amount = selectPositionAmount(value, BigInt(c.position.trackedPt));
    if (!amount) return { status: "empty", state: c.inspected.state, steps: [] };
    if (amount > BigInt(c.balances.pt)) throw new MobileApiError("INSUFFICIENT_PT", "Tracked PT is missing from Safe", 422);
  }
  // Chain clock selects sale/redemption. Host time never enables early redemption.
  const clock = await c.connection.getAccountInfo(new PublicKey("SysvarC1ock11111111111111111111111111111111"), "confirmed");
  if (!clock || clock.data.length !== 40) throw new MobileApiError("CLOCK_UNAVAILABLE", "Chain clock unavailable", 503);
  const action = kind === "deposit" ? "buy" : Number(clock.data.readBigInt64LE(32)) >= EXPONENT.maturity ? "redeem" : "sell";
  const built = await unsignedTransaction(c.connection, { market: EXPONENT_MARKET, action, amount: String(amount), owner: owner.toBase58(), authority: owner.toBase58(), asset: "USDC", slippageBps: Number(value.slippageBps ?? 50) }, kind === "deposit" && value.source === "wallet");
  return { ...await envelope(c, built, "exponent_" + action), phase: action, source: value.source ?? "safe", amountRaw: String(amount), atomic: true, allocationBpsAfter: built.allocationBpsAfter,
    destination: kind === "withdraw" ? tokenAddress(owner, EXPONENT.usdc).toBase58() : tokenAddress(c.inspected.addresses.safe, EXPONENT.pt).toBase58(),
    settlement: kind === "withdraw" ? "usdc_to_owner_wallet" : "pt_in_safe", pilotPerformanceFeeUsdc: "0" };
}
