import { BN, BorshAccountsCoder, BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import { ACCOUNT_SIZE, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, unpackAccount, unpackMint } from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, type AccountInfo } from "@solana/web3.js";
import { createHash } from "node:crypto";
import idlJson from "../idl/yield_vault.json" with { type: "json" };

// Existing Anchor ABI is retained at this boundary. No wallet/keypair is held by this API.
export const MOBILE_NETWORKS = {
  devnet: {
    cluster: "devnet", chain: "solana:devnet",
    genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    programId: "8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5",
    usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  },
  mainnet: {
    cluster: "mainnet", chain: "solana:mainnet",
    genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    programId: "yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih",
    usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
} as const;
export type MobileNetwork = (typeof MOBILE_NETWORKS)[keyof typeof MOBILE_NETWORKS];
export const SAFE_SPACE = 8 + 1 + 32 + 32 + 16 + 8 + 4 + 16 * 32 + 8 * 8;
export const LIMITS_SPACE = 8 + 32 + 1 + 1 + 8 * 3 + 25 * 8 * 2;
export const DEFAULT_LIMITS = { enabled: true, maxActionUsdc: "1000.000000", max24hVolumeUsdc: "1000.000000", maxPrincipalUsdc: "1000.000000" };
const accountsCoder = new BorshAccountsCoder(idlJson as Idl);
const instructionCoder = new BorshInstructionCoder(idlJson as Idl);
const COMPUTE_LIMIT = 200_000;
const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
type RegistryAccount = { bump: number; default_executor: PublicKey; approved: PublicKey[] };
type VaultAccount = { bump: number; owner: PublicKey; agent: PublicKey; allocation_bps: number[]; route_principal: RawAmount[] };
type RawAmount = { toString(): string };
type LimitsAccount = { bump: number; vault: PublicKey; enabled: boolean; max_action_usdc: RawAmount; max_24h_volume_usdc: RawAmount; max_principal_usdc: RawAmount };

export class MobileApiError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;
  constructor(code: string, message: string, status = 400, details?: Record<string, unknown>) {
    super(message); this.code = code; this.status = status; this.details = details;
  }
}
function fail(code: string, message: string, status = 503): never { throw new MobileApiError(code, message, status); }
export function solanaOwner(input: unknown): PublicKey {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail("INVALID_OWNER", "owner must contain type and address", 400);
  const owner = input as Record<string, unknown>;
  if (owner.type !== "solana") fail("UNSUPPORTED_OWNER_TYPE", "This endpoint currently supports Solana wallet owners", 400);
  if (Object.keys(owner).some((key) => key !== "type" && key !== "address")) fail("INVALID_OWNER", "Unexpected owner field", 400);
  try {
    if (typeof owner.address !== "string") throw new Error();
    const key = new PublicKey(owner.address);
    if (key.toBase58() !== owner.address || !PublicKey.isOnCurve(key.toBytes()) || key.equals(PublicKey.default)) throw new Error();
    return key;
  } catch { return fail("INVALID_OWNER", "Expected a canonical on-curve Solana wallet address", 400); }
}
export function requireCluster(cluster: unknown, network: MobileNetwork) {
  if (cluster !== network.cluster) fail("CLUSTER_MISMATCH", "Request cluster must match the API configuration", 400);
}
export function safeAddresses(owner: PublicKey, network: MobileNetwork) {
  const program = new PublicKey(network.programId);
  const [safe, safeBump] = PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.toBuffer()], program);
  const [limits, limitsBump] = PublicKey.findProgramAddressSync([Buffer.from("executor_limits"), safe.toBuffer()], program);
  const [registry, registryBump] = PublicKey.findProgramAddressSync([Buffer.from("executor_registry")], program);
  const mint = new PublicKey(network.usdcMint);
  return { program, safe, safeBump, limits, limitsBump, registry, registryBump, mint, ata: getAssociatedTokenAddressSync(mint, safe, true), ownerAta: getAssociatedTokenAddressSync(mint, owner) };
}
function decode<T>(name: string, info: AccountInfo<Buffer>, program: PublicKey): T {
  if (!info.owner.equals(program) || info.executable) fail("INVALID_ACCOUNT", `${name} has an unexpected program owner`);
  try { return accountsCoder.decode(name, info.data); }
  catch { return fail("INVALID_ACCOUNT", `${name} has an invalid discriminator or layout`); }
}
function uninitialized(info: AccountInfo<Buffer> | null) {
  return !info || (info.owner.equals(SystemProgram.programId) && !info.executable && info.data.length === 0);
}
function usdc(raw: { toString(): string } | bigint) {
  const n = BigInt(raw.toString());
  return `${n / BigInt(1_000_000)}.${(n % BigInt(1_000_000)).toString().padStart(6, "0")}`;
}
export function usdcAmount(input: unknown): bigint {
  if (typeof input !== "string" || input.length > 27 || !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(input)) fail("INVALID_AMOUNT", "Use a positive decimal USDC string with at most six decimal places", 400);
  const [whole, fraction = ""] = input.split(".");
  const amount = BigInt(whole) * BigInt(1_000_000) + BigInt(fraction.padEnd(6, "0"));
  if (amount === BigInt(0) || amount > (BigInt(1) << BigInt(64)) - BigInt(1)) fail("INVALID_AMOUNT", "USDC amount must be positive and fit u64", 400);
  return amount;
}
function tokenBalance(address: PublicKey, info: AccountInfo<Buffer> | null, authority: PublicKey, mint: PublicKey, safe = false) {
  if (uninitialized(info)) return BigInt(0);
  try {
    const token = unpackAccount(address, info);
    if (!token.owner.equals(authority) || !token.mint.equals(mint) || !token.isInitialized || token.isFrozen ||
        (safe && (token.delegate || token.closeAuthority))) throw new Error();
    return token.amount;
  } catch { return fail("INVALID_ACCOUNT", "USDC account has invalid mint, authority or state"); }
}
export async function inspectSafe(connection: Connection, network: MobileNetwork, owner: PublicKey) {
  const addresses = safeAddresses(owner, network);
  const { program, safe, limits, registry, mint, ata, ownerAta } = addresses;
  const [genesis, snapshot, balance] = await Promise.all([
    connection.getGenesisHash(),
    connection.getMultipleAccountsInfoAndContext([program, registry, mint, safe, limits, ata, ownerAta], { commitment: "confirmed" }),
    connection.getBalance(owner, "confirmed"),
  ]);
  if (genesis !== network.genesis) fail("RPC_CLUSTER_MISMATCH", "Configured RPC points to a different Solana cluster");
  const [programInfo, registryInfo, mintInfo, safeInfo, limitsInfo, ataInfo, ownerAtaInfo] = snapshot.value;
  if (!programInfo?.executable || !programInfo.owner.equals(UPGRADEABLE_LOADER)) fail("PROGRAM_UNAVAILABLE", "Safe program is not deployed on this cluster");
  if (!Number.isSafeInteger(balance) || balance < 0) fail("INVALID_RPC_RESPONSE", "Wallet SOL balance is outside the supported range");
  if (!registryInfo) fail("EXECUTOR_UNAVAILABLE", "Executor registry has not been initialized");
  const reg = decode<RegistryAccount>("ExecutorRegistry", registryInfo, program);
  if (reg.bump !== addresses.registryBump || reg.approved.length > 16 ||
      new Set(reg.approved.map((key: PublicKey) => key.toBase58())).size !== reg.approved.length ||
      reg.approved.some((key: PublicKey) => key.equals(PublicKey.default))) fail("INVALID_ACCOUNT", "Invalid executor registry");
  // The current contract requires an approved nonzero executor on both networks.
  const defaultExecutor: PublicKey = reg.default_executor;
  const defaultAvailable = !defaultExecutor.equals(PublicKey.default) && reg.approved.some((key: PublicKey) => key.equals(defaultExecutor));
  try {
    const decodedMint = unpackMint(mint, mintInfo);
    if (!decodedMint.isInitialized || decodedMint.decimals !== 6) throw new Error();
  } catch { fail("INVALID_ACCOUNT", "USDC mint is not an initialized six-decimal SPL mint"); }
  let vault: VaultAccount | null = null;
  if (!uninitialized(safeInfo)) {
    vault = decode<VaultAccount>("Vault", safeInfo!, program);
    if (!vault.owner.equals(owner) || vault.bump !== addresses.safeBump || vault.allocation_bps.reduce((a: number, b: number) => a + b, 0) > 10_000) fail("INVALID_ACCOUNT", "Safe does not match its owner or PDA");
  }
  let policy: LimitsAccount | null = null;
  if (!uninitialized(limitsInfo)) {
    policy = decode<LimitsAccount>("ExecutorLimits", limitsInfo!, program);
    if (!policy.vault.equals(safe) || policy.bump !== addresses.limitsBump) fail("INVALID_ACCOUNT", "Executor policy does not match this Safe");
  }
  const ataExists = !uninitialized(ataInfo);
  const balanceUsdc = tokenBalance(ata, ataInfo, safe, mint, true);
  const walletUsdc = tokenBalance(ownerAta, ownerAtaInfo, owner, mint);
  const state = {
    owner: { type: "solana" as const, address: owner.toBase58() }, network,
    safe: safe.toBase58(), usdcAta: ata.toBase58(), executorLimitsAddress: limits.toBase58(),
    exists: vault !== null, usdcAccountExists: ataExists, walletSolLamports: String(balance),
    idleUsdc: usdc(balanceUsdc), allocationBps: vault?.allocation_bps ?? null,
    ownerUsdcAta: ownerAta.toBase58(), ownerUsdcAccountExists: !uninitialized(ownerAtaInfo), walletUsdc: usdc(walletUsdc),
    routePrincipalUsdc: vault?.route_principal.map(usdc) ?? Array(8).fill("0.000000"),
    executor: vault ? vault.agent.toBase58() : null,
    executorApproved: vault ? reg.approved.some((key: PublicKey) => key.equals(vault.agent)) : false,
    defaultExecutor: defaultAvailable ? defaultExecutor.toBase58() : null,
    executorLimits: policy ? { enabled: policy.enabled, maxActionUsdc: usdc(policy.max_action_usdc), max24hVolumeUsdc: usdc(policy.max_24h_volume_usdc), maxPrincipalUsdc: usdc(policy.max_principal_usdc) } : null,
    slot: snapshot.context.slot, updatedAt: Date.now(),
  };
  return { state, addresses, defaultExecutor, defaultAvailable, balanceUsdc, walletUsdc, infos: { safeInfo, limitsInfo, ataInfo, ownerAtaInfo } };
}
export async function creationPlan(connection: Connection, network: MobileNetwork, owner: PublicKey) {
  const inspected = await inspectSafe(connection, network, owner);
  const { state, addresses: a, infos, defaultExecutor, defaultAvailable } = inspected;
  if (state.exists) return { status: "already_exists" as const, state, steps: [] };
  if (!defaultAvailable) fail("EXECUTOR_UNAVAILABLE", "Admin has not approved a default executor for new Safes");
  // An orphan policy is not silently reset by init_if_needed.
  if (state.executorLimits) fail("INVALID_ACCOUNT", "Executor policy exists without an initialized Safe");
  const [safeRent, limitsRent, ataRent] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(SAFE_SPACE),
    connection.getMinimumBalanceForRentExemption(LIMITS_SPACE),
    connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE),
  ]);
  const rent = Math.max(0, safeRent - (infos.safeInfo?.lamports ?? 0)) + Math.max(0, limitsRent - (infos.limitsInfo?.lamports ?? 0)) + (state.usdcAccountExists ? 0 : Math.max(0, ataRent - (infos.ataInfo?.lamports ?? 0)));
  const data = instructionCoder.encode("initialize_with_limits", { agent: defaultExecutor, allocation_bps: Array(8).fill(0), allowed_programs: [] });
  const initialize = new TransactionInstruction({ programId: a.program, data, keys: [
    { pubkey: owner, isSigner: true, isWritable: true },
    { pubkey: a.safe, isSigner: false, isWritable: true },
    { pubkey: a.registry, isSigner: false, isWritable: false },
    { pubkey: a.mint, isSigner: false, isWritable: false },
    { pubkey: a.ata, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: a.limits, isSigner: false, isWritable: true },
  ] });
  const plan = await ownerPlan(connection, network, owner, state, rent, [initialize], "create_safe", "Create your Solana Safe");
  return { ...plan, defaults: { executor: defaultExecutor.toBase58(), executorLimits: DEFAULT_LIMITS, allocationBps: Array(8).fill(0) } };
}

async function ownerPlan(connection: Connection, network: MobileNetwork, owner: PublicKey, state: Awaited<ReturnType<typeof inspectSafe>>["state"], rent: number, instructions: TransactionInstruction[], kind: string, title: string) {
  const latest = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: owner, recentBlockhash: latest.blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_LIMIT }), ...instructions] }).compileToV0Message();
  const fee = (await connection.getFeeForMessage(message, "confirmed")).value;
  if (fee === null) fail("BLOCKHASH_UNAVAILABLE", "Cannot estimate the fee; request a new plan");
  const required = rent + fee;
  const cost = { rentLamports: String(rent), networkFeeLamports: String(fee), totalLamports: String(required), walletSolLamports: state.walletSolLamports, feePayer: owner.toBase58(), priorityFeeLamports: "0" };
  if (BigInt(state.walletSolLamports) < BigInt(required)) throw new MobileApiError("INSUFFICIENT_SOL", "Owner needs SOL for account rent and the network fee", 422, { cost, network, safe: state.safe });
  const tx = new VersionedTransaction(message);
  const simulation = await connection.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed", minContextSlot: state.slot });
  if (simulation.value.err) fail("SIMULATION_FAILED", "Safe operation was rejected by the configured cluster; refresh state and retry", 422);
  const serialized = Buffer.from(tx.serialize());
  const planId = createHash("sha256").update(network.genesis).update(serialized).digest("hex");
  return {
    status: "ready" as const, planId, state, cost,
    // Block height is authoritative; a wall-clock expiry would only be an estimate.
    blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight,
    simulation: { slot: simulation.context.slot, unitsConsumed: simulation.value.unitsConsumed ?? null },
    steps: [{ id: kind, kind: kind === "create_safe" ? "setup" : kind, title, transaction: serialized.toString("base64"), transactionVersion: 0, requiredSigners: [owner.toBase58()] }],
    createdAt: Date.now(),
  };
}

/** Wallet -> idle Safe USDC, or idle Safe USDC -> the same owner's canonical ATA. */
export async function usdcTransferPlan(connection: Connection, network: MobileNetwork, owner: PublicKey, kind: "deposit" | "withdraw", input: unknown) {
  // Parse input before any RPC access. "all" is only valid for withdrawal.
  const requested = kind === "withdraw" && input === "all" ? null : usdcAmount(input);
  const inspected = await inspectSafe(connection, network, owner);
  const { state, addresses: a, infos, balanceUsdc, walletUsdc } = inspected;
  if (!state.exists) fail("SAFE_NOT_CREATED", "Create the Safe and confirm it before requesting this operation", 409);
  const available = kind === "deposit" ? walletUsdc : balanceUsdc;
  const amount = requested ?? available;
  if (amount === BigInt(0)) return { status: "empty" as const, state, scope: "idle_usdc", steps: [] };
  if (amount > available) throw new MobileApiError("INSUFFICIENT_USDC", kind === "deposit" ? "Wallet does not hold enough USDC" : "Safe does not hold enough idle USDC; protocol positions are not redeemed by this endpoint", 422, { availableUsdc: usdc(available), scope: "idle_usdc" });
  const target = kind === "deposit" ? a.ata : a.ownerAta;
  const targetAuthority = kind === "deposit" ? a.safe : owner;
  const targetInfo = kind === "deposit" ? infos.ataInfo : infos.ownerAtaInfo;
  const instructions: TransactionInstruction[] = [];
  let rent = 0;
  if (uninitialized(targetInfo)) {
    rent = Math.max(0, await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE) - (targetInfo?.lamports ?? 0));
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(owner, target, targetAuthority, a.mint));
  }
  instructions.push(new TransactionInstruction({ programId: a.program,
    data: instructionCoder.encode(kind, { amount: new BN(amount.toString()) }),
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: a.safe, isSigner: false, isWritable: true },
      { pubkey: a.mint, isSigner: false, isWritable: false },
      { pubkey: a.ownerAta, isSigner: false, isWritable: true },
      { pubkey: a.ata, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  }));
  const plan = await ownerPlan(connection, network, owner, state, rent, instructions, kind, kind === "deposit" ? "Deposit USDC into your Safe" : "Withdraw USDC to your wallet");
  return { ...plan, scope: "idle_usdc", amount: usdc(amount), amountRaw: amount.toString(),
    source: (kind === "deposit" ? a.ownerAta : a.ata).toBase58(), destination: target.toBase58(),
    allIdleAtPlanTime: requested === null,
  };
}
