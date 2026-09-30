import { BN, BorshAccountsCoder, BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import { ACCOUNT_SIZE, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, unpackAccount, unpackMint } from "@solana/spl-token";
import { AddressLookupTableAccount, ComputeBudgetProgram, Connection, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, type AccountInfo } from "@solana/web3.js";
import { createHash } from "node:crypto";
import bs58 from "bs58";
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

async function ownerPlan(connection: Connection, network: MobileNetwork, owner: PublicKey, state: Awaited<ReturnType<typeof inspectSafe>>["state"], rent: number, instructions: TransactionInstruction[], kind: string, title: string, lookupTables: AddressLookupTableAccount[] = [], computeLimit = COMPUTE_LIMIT) {
  const latest = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: owner, recentBlockhash: latest.blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: computeLimit }), ...instructions] }).compileToV0Message(lookupTables);
  if (message.header.numRequiredSignatures !== 1 || !message.staticAccountKeys[0].equals(owner)) fail("INVALID_TRANSACTION", "Plan must require only the owner's signature");
  const tx = new VersionedTransaction(message);
  let serialized: Buffer;
  try { serialized = Buffer.from(tx.serialize()); } catch { return fail("TRANSACTION_TOO_LARGE", "Operation cannot fit into one transaction", 422); }
  if (serialized.length > 1232) fail("TRANSACTION_TOO_LARGE", "Operation cannot fit into one transaction", 422);
  const fee = (await connection.getFeeForMessage(message, "confirmed")).value;
  if (fee === null) fail("BLOCKHASH_UNAVAILABLE", "Cannot estimate the fee; request a new plan");
  const required = rent + fee;
  const cost = { rentLamports: String(rent), networkFeeLamports: String(fee), totalLamports: String(required), walletSolLamports: state.walletSolLamports, feePayer: owner.toBase58(), priorityFeeLamports: "0" };
  if (BigInt(state.walletSolLamports) < BigInt(required)) throw new MobileApiError("INSUFFICIENT_SOL", "Owner needs SOL for account rent and the network fee", 422, { cost, network, safe: state.safe });
  const simulation = await connection.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed", minContextSlot: state.slot });
  if (simulation.value.err) fail("SIMULATION_FAILED", "Safe operation was rejected by the configured cluster; refresh state and retry", 422);
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

// Mainnet-only typed route already supported by the deployed Safe and its owner UI.
export const MOBILE_KAMINO = {
  vault: "91b1opzHNUQobfLZxGMNYT5qDRKoqV8FdsdQBmH4wBxy",
  program: "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd",
  sharesMint: "B9t9wg8r39Lxm2D9Gmqn2rJ5pVQQwjtGBfSsHAXSEnVe",
  minimumDepositUsdc: "1.000000",
} as const;
type KaminoMeta = { pubkey: PublicKey; isSigner: false; isWritable: boolean };
/** Use only the typed deposit's account list; never forward KTX setup/farm/raw instructions. */
export function checkedKaminoDeposit(payload: unknown, safe: PublicKey, owner: PublicKey, amount: bigint) {
  const invalid = () => fail("INVALID_KAMINO_RESPONSE", "Kamino returned an unexpected deposit layout", 502);
  if (!payload || typeof payload !== "object") return invalid();
  const p = payload as { instructions?: { programAddress?: string; data?: string; accounts?: { address?: string; role?: string }[] }[]; lutsByAddress?: Record<string, unknown> };
  if (!Array.isArray(p.instructions) || p.instructions.length > 64) return invalid();
  const deposits = p.instructions.filter((ix) => ix?.programAddress === MOBILE_KAMINO.program);
  if (deposits.length !== 1) return invalid();
  const ix = deposits[0];
  if (typeof ix.data !== "string") return invalid();
  const data = Buffer.from(ix.data, "base64");
  if (data.length !== 16 || data.toString("base64") !== ix.data || data.subarray(0, 8).toString("hex") !== "f223c68952e1f2b6" || data.readBigUInt64LE(8) !== amount) return invalid();
  if (!Array.isArray(ix.accounts) || ix.accounts.length < 13 || ix.accounts.length > 64) return invalid();
  const sharesAta = getAssociatedTokenAddressSync(new PublicKey(MOBILE_KAMINO.sharesMint), safe, true);
  const usdcAta = getAssociatedTokenAddressSync(new PublicKey(MOBILE_NETWORKS.mainnet.usdcMint), safe, true);
  const fixed: Record<number, string> = {
    0: safe.toBase58(), 1: MOBILE_KAMINO.vault, 3: MOBILE_NETWORKS.mainnet.usdcMint,
    5: MOBILE_KAMINO.sharesMint, 6: usdcAta.toBase58(), 7: sharesAta.toBase58(),
    8: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
    9: TOKEN_PROGRAM_ID.toBase58(), 10: TOKEN_PROGRAM_ID.toBase58(), 12: MOBILE_KAMINO.program,
  };
  const accounts: KaminoMeta[] = ix.accounts.map((a, index) => {
    if (!a || typeof a.address !== "string" || !["WRITABLE_SIGNER", "READONLY_SIGNER", "WRITABLE", "READONLY"].includes(a.role ?? "")) return invalid();
    let pubkey: PublicKey;
    try { pubkey = new PublicKey(a.address); } catch { return invalid(); }
    if (pubkey.toBase58() !== a.address || pubkey.equals(owner) || (index !== 0 && pubkey.equals(safe)) ||
        (fixed[index] && a.address !== fixed[index]) || (index === 0 ? !a.role!.includes("SIGNER") : a.role!.includes("SIGNER"))) return invalid();
    if ([0, 1, 5, 6, 7].includes(index) && !a.role!.includes("WRITABLE")) return invalid();
    return { pubkey, isSigner: false, isWritable: a.role!.includes("WRITABLE") };
  });
  if (p.lutsByAddress !== undefined && (!p.lutsByAddress || Array.isArray(p.lutsByAddress) || typeof p.lutsByAddress !== "object")) return invalid();
  const tables = Object.keys(p.lutsByAddress ?? {});
  if (tables.length > 4) return invalid();
  const lookupTables = tables.map((key) => {
    try { const pk = new PublicKey(key); if (pk.toBase58() !== key) return invalid(); return pk; } catch { return invalid(); }
  });
  return { accounts, lookupTables, sharesAta };
}

/** One owner signature: Safe -> Kamino, or wallet -> Safe -> Kamino, with allocation restored atomically. */
export async function kaminoDepositPlan(connection: Connection, network: MobileNetwork, owner: PublicKey, source: unknown, input: unknown, fetcher: typeof fetch = fetch) {
  if (source !== "safe" && source !== "wallet") fail("INVALID_SOURCE", "source must be safe or wallet", 400);
  const amount = usdcAmount(input);
  if (network.cluster !== "mainnet") fail("PROTOCOL_UNAVAILABLE", "This Kamino route is supported only on Solana Mainnet", 409);
  if (amount < BigInt(1_000_000)) fail("AMOUNT_BELOW_MINIMUM", "Use at least 1 USDC for the current Kamino vault", 422);
  const inspected = await inspectSafe(connection, network, owner);
  const { state, addresses: a, infos } = inspected;
  if (!state.exists) fail("SAFE_NOT_CREATED", "Create the Safe and confirm it before investing", 409);
  const available = source === "wallet" ? inspected.walletUsdc : inspected.balanceUsdc;
  if (amount > available) throw new MobileApiError("INSUFFICIENT_USDC", "Selected source does not hold enough USDC", 422, { availableUsdc: usdc(available), source });
  let response: Response;
  try {
    response = await fetcher("https://api.kamino.finance/ktx/kvault/deposit-instructions", {
      method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ wallet: a.safe.toBase58(), kvault: MOBILE_KAMINO.vault, amount: usdc(amount) }),
    });
  } catch { return fail("KAMINO_UNAVAILABLE", "Could not request Kamino deposit accounts; retry later", 502); }
  if (!response.ok) fail("KAMINO_UNAVAILABLE", "Kamino could not build this deposit; retry later", 502);
  let payload: unknown;
  try { payload = await response.json(); } catch { return fail("INVALID_KAMINO_RESPONSE", "Kamino returned invalid JSON", 502); }
  const checked = checkedKaminoDeposit(payload, a.safe, owner, amount);
  const sharesMint = new PublicKey(MOBILE_KAMINO.sharesMint);
  const snapshot = await connection.getMultipleAccountsInfoAndContext([new PublicKey(MOBILE_KAMINO.program), new PublicKey(MOBILE_KAMINO.vault), sharesMint, checked.sharesAta], { commitment: "confirmed", minContextSlot: state.slot });
  const [programInfo, vaultInfo, sharesMintInfo, sharesInfo] = snapshot.value;
  if (!programInfo?.executable || !programInfo.owner.equals(UPGRADEABLE_LOADER) || !vaultInfo?.owner.equals(new PublicKey(MOBILE_KAMINO.program)) || vaultInfo.executable) fail("PROTOCOL_UNAVAILABLE", "Kamino program or vault is unavailable", 503);
  try { if (!unpackMint(sharesMint, sharesMintInfo).isInitialized) throw new Error(); } catch { fail("INVALID_ACCOUNT", "Kamino shares mint is invalid"); }
  tokenBalance(checked.sharesAta, sharesInfo, a.safe, sharesMint, true);
  const lookupTables = await Promise.all(checked.lookupTables.map(async (key) => {
    const table = (await connection.getAddressLookupTable(key, { commitment: "confirmed", minContextSlot: state.slot })).value;
    if (!table || !table.key.equals(key) || !table.isActive()) return fail("LOOKUP_TABLE_UNAVAILABLE", "Kamino lookup table is unavailable; retry later", 503);
    return table;
  }));
  const original = state.allocationBps!;
  const temporary = [10_000, 0, 0, 0, 0, 0, 0, 0];
  const needsTemporary = original.some((bps, i) => bps !== temporary[i]);
  const allocation = (bps: number[]) => new TransactionInstruction({ programId: a.program, data: instructionCoder.encode("set_allocation", { allocation_bps: bps }), keys: [
    { pubkey: owner, isSigner: true, isWritable: false }, { pubkey: a.safe, isSigner: false, isWritable: true },
  ] });
  const instructions: TransactionInstruction[] = [];
  let rent = 0;
  const ataRent = await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
  if (!state.usdcAccountExists) {
    rent += Math.max(0, ataRent - (infos.ataInfo?.lamports ?? 0));
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(owner, a.ata, a.safe, a.mint));
  }
  if (needsTemporary) instructions.push(allocation(temporary));
  if (source === "wallet") instructions.push(new TransactionInstruction({ programId: a.program, data: instructionCoder.encode("deposit", { amount: new BN(amount.toString()) }), keys: [
    { pubkey: owner, isSigner: true, isWritable: true }, { pubkey: a.safe, isSigner: false, isWritable: true },
    { pubkey: a.mint, isSigner: false, isWritable: false }, { pubkey: a.ownerAta, isSigner: false, isWritable: true },
    { pubkey: a.ata, isSigner: false, isWritable: true }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ] }));
  if (uninitialized(sharesInfo)) {
    rent += Math.max(0, ataRent - (sharesInfo?.lamports ?? 0));
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(owner, checked.sharesAta, a.safe, sharesMint));
  }
  instructions.push(new TransactionInstruction({ programId: a.program, data: instructionCoder.encode("kamino_deposit", { amount: new BN(amount.toString()) }), keys: [
    { pubkey: owner, isSigner: true, isWritable: false }, { pubkey: a.safe, isSigner: false, isWritable: true },
    { pubkey: a.registry, isSigner: false, isWritable: false },
    { pubkey: new PublicKey(MOBILE_KAMINO.program), isSigner: false, isWritable: false }, ...checked.accounts,
  ] }));
  if (needsTemporary) instructions.push(allocation(original));
  const plan = await ownerPlan(connection, network, owner, { ...state, slot: Math.max(state.slot, snapshot.context.slot) }, rent, instructions, "kamino_deposit", "Invest USDC in Kamino", lookupTables, 400_000);
  return { ...plan, scope: "kamino_usdc", source, amount: usdc(amount), amountRaw: amount.toString(), amountMeaning: "maximum_kamino_input",
    sourceAccount: (source === "wallet" ? a.ownerAta : a.ata).toBase58(), destinationSharesAta: checked.sharesAta.toBase58(),
    route: MOBILE_KAMINO, allocationBpsAfter: original, atomic: true,
  };
}

type WithdrawalBundle = { safe: string; withdrawals: { shares: string; discriminator: string; accounts: { address: string; writable: boolean }[] }[]; lookupTables: string[] };
export type WithdrawalBuilder = (safe: PublicKey, shares: bigint) => Promise<WithdrawalBundle>;
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
function rawShares(input: unknown) {
  if (typeof input !== "string" || input.length > 20 || !/^[1-9]\d*$/.test(input) || BigInt(input) > U64_MAX) fail("INVALID_SHARES", "Use a positive raw shares string fitting u64", 400);
  return BigInt(input);
}
/** Bound the SDK's first leg to the user's snapshot target, including its redeem-all sentinel. */
export function checkedKaminoWithdrawal(bundle: WithdrawalBundle, safe: PublicKey, owner: PublicKey, requested: bigint) {
  const invalid = () => fail("INVALID_KAMINO_RESPONSE", "Kamino returned an unexpected withdrawal layout", 502);
  if (bundle.safe !== String(safe) || !Array.isArray(bundle.withdrawals) || !bundle.withdrawals.length || bundle.withdrawals.length > 32) return invalid();
  const leg = bundle.withdrawals[0];
  const fromReserve = leg.discriminator === "b712469c946da122";
  if (!fromReserve && leg.discriminator !== "1383709baadc2239") return invalid();
  let shares: bigint;
  try { shares = rawShares(leg.shares); } catch { return invalid(); }
  if (shares === U64_MAX) shares = requested;
  if (shares > requested || requested <= BigInt(0) || !Array.isArray(leg.accounts) || leg.accounts.length < (fromReserve ? 25 : 14) || leg.accounts.length > 64) return invalid();
  const sharesAta = getAssociatedTokenAddressSync(new PublicKey(MOBILE_KAMINO.sharesMint), safe, true);
  const usdcAta = getAssociatedTokenAddressSync(new PublicKey(MOBILE_NETWORKS.mainnet.usdcMint), safe, true);
  const fixed: Record<number, string> = { 0: String(safe), 1: MOBILE_KAMINO.vault, 5: String(usdcAta), 6: MOBILE_NETWORKS.mainnet.usdcMint, 7: String(sharesAta), 8: MOBILE_KAMINO.sharesMint, 9: String(TOKEN_PROGRAM_ID), 10: String(TOKEN_PROGRAM_ID), 11: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD", 13: MOBILE_KAMINO.program };
  if (fromReserve) { fixed[14] = MOBILE_KAMINO.vault; fixed[24] = MOBILE_KAMINO.program; }
  const accounts = leg.accounts.map((meta, i) => {
    let key: PublicKey;
    try { key = new PublicKey(meta.address); } catch { return invalid(); }
    if (String(key) !== meta.address || typeof meta.writable !== "boolean" || key.equals(owner) || (i !== 0 && key.equals(safe)) || (fixed[i] && fixed[i] !== meta.address) || ([1,5,6,7,8].includes(i) && !meta.writable)) return invalid();
    return { pubkey: key, isSigner: false, isWritable: meta.writable };
  });
  if (!Array.isArray(bundle.lookupTables) || bundle.lookupTables.length > 4) return invalid();
  const lookupTables = bundle.lookupTables.map((s) => { try { const key = new PublicKey(s); if (String(key) !== s) return invalid(); return key; } catch { return invalid(); } });
  return { shares, fromReserve, accounts, lookupTables, sharesAta };
}

/** Build one confirmed-state redemption leg. It never guesses a later USDC transfer amount. */
export async function kaminoWithdrawalPlan(connection: Connection, network: MobileNetwork, owner: PublicKey, selection: { shares?: unknown; percent?: unknown }, builder: WithdrawalBuilder) {
  if ((selection.shares === undefined) === (selection.percent === undefined)) fail("INVALID_REQUEST", "Provide exactly one of shares or percent", 400);
  let percentBps: bigint | null = null;
  if (selection.percent !== undefined) {
    if (typeof selection.percent !== "string" || !/^(0|[1-9]\d{0,2})(\.\d{1,2})?$/.test(selection.percent)) fail("INVALID_PERCENT", "Use a percent string greater than zero and at most 100, with two decimal places", 400);
    const [n, f = ""] = selection.percent.split("."); percentBps = BigInt(n) * BigInt(100) + BigInt(f.padEnd(2, "0"));
    if (percentBps <= BigInt(0) || percentBps > BigInt(10_000)) fail("INVALID_PERCENT", "Percent must be greater than zero and at most 100", 400);
  }
  const requested = selection.shares === "all" || percentBps !== null ? null : rawShares(selection.shares);
  if (network.cluster !== "mainnet") fail("PROTOCOL_UNAVAILABLE", "This Kamino route is supported only on Solana Mainnet", 409);
  const inspected = await inspectSafe(connection, network, owner);
  const { state, addresses: a } = inspected;
  if (!state.exists) fail("SAFE_NOT_CREATED", "Create the Safe first", 409);
  const sharesMint = new PublicKey(MOBILE_KAMINO.sharesMint), sharesAta = getAssociatedTokenAddressSync(sharesMint, a.safe, true);
  const [config, bump] = PublicKey.findProgramAddressSync([Buffer.from("config")], a.program);
  const snapshot = await connection.getMultipleAccountsInfoAndContext([new PublicKey(MOBILE_KAMINO.program), new PublicKey(MOBILE_KAMINO.vault), sharesMint, sharesAta, config], { commitment: "confirmed", minContextSlot: state.slot });
  const [programInfo, vaultInfo, mintInfo, sharesInfo, configInfo] = snapshot.value;
  if (!programInfo?.executable || !programInfo.owner.equals(UPGRADEABLE_LOADER) || !vaultInfo?.owner.equals(new PublicKey(MOBILE_KAMINO.program)) || vaultInfo.executable) fail("PROTOCOL_UNAVAILABLE", "Kamino program or vault is unavailable");
  try { if (!unpackMint(sharesMint, mintInfo).isInitialized) throw new Error(); } catch { fail("INVALID_ACCOUNT", "Kamino shares mint is invalid"); }
  const available = tokenBalance(sharesAta, sharesInfo, a.safe, sharesMint, true);
  const target = requested ?? (percentBps === null ? available : available * percentBps / BigInt(10_000));
  if (target === BigInt(0)) {
    if (selection.shares !== "all") fail("AMOUNT_BELOW_MINIMUM", "Selection rounds down to zero shares", 422);
    return { status: "redeemed" as const, state, scope: "kamino_usdc", sharesRaw: "0", steps: [], next: { endpoint: "/api/mobile/v1/withdrawals/plan", amount: "all", meaning: "all idle Safe USDC; does not sell other assets" } };
  }
  if (target > available) throw new MobileApiError("INSUFFICIENT_SHARES", "Safe does not hold enough Kamino shares", 422, { availableSharesRaw: String(available) });
  if (!configInfo) fail("INVALID_ACCOUNT", "Safe fee config is missing");
  const cfg = decode<{ treasury: PublicKey; performance_fee_bps: number; bump: number }>("Config", configInfo, a.program);
  if (cfg.bump !== bump || cfg.performance_fee_bps > 2000 || cfg.treasury.equals(PublicKey.default)) fail("INVALID_ACCOUNT", "Safe fee config is invalid");
  let bundle: WithdrawalBundle;
  try { bundle = await builder(a.safe, target); } catch { return fail("KAMINO_UNAVAILABLE", "Could not build a withdrawal from current Kamino liquidity; retry later", 502); }
  const leg = checkedKaminoWithdrawal(bundle, a.safe, owner, target);
  const tables = await Promise.all(leg.lookupTables.map(async (key) => {
    const table = (await connection.getAddressLookupTable(key, { commitment: "confirmed", minContextSlot: snapshot.context.slot })).value;
    if (!table || !table.key.equals(key) || !table.isActive()) return fail("LOOKUP_TABLE_UNAVAILABLE", "Kamino lookup table is unavailable");
    return table;
  }));
  const treasuryAta = getAssociatedTokenAddressSync(a.mint, cfg.treasury, true);
  const treasurySnapshot = await connection.getMultipleAccountsInfoAndContext([treasuryAta], { commitment: "confirmed", minContextSlot: snapshot.context.slot });
  const treasuryInfo = treasurySnapshot.value[0];
  tokenBalance(treasuryAta, treasuryInfo, cfg.treasury, a.mint);
  const rent = uninitialized(treasuryInfo) ? Math.max(0, await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE) - (treasuryInfo?.lamports ?? 0)) : 0;
  const instructions = [createAssociatedTokenAccountIdempotentInstruction(owner, treasuryAta, cfg.treasury, a.mint), new TransactionInstruction({ programId: a.program, data: instructionCoder.encode("kamino_withdraw", { shares: new BN(leg.shares.toString()), from_reserve: leg.fromReserve }), keys: [
    { pubkey: owner, isSigner: true, isWritable: false }, { pubkey: a.safe, isSigner: false, isWritable: true }, { pubkey: a.registry, isSigner: false, isWritable: false }, { pubkey: config, isSigner: false, isWritable: false }, { pubkey: treasuryAta, isSigner: false, isWritable: true }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: new PublicKey(MOBILE_KAMINO.program), isSigner: false, isWritable: false }, ...leg.accounts,
  ] })];
  const plan = await ownerPlan(connection, network, owner, { ...state, slot: Math.max(snapshot.context.slot, treasurySnapshot.context.slot) }, rent, instructions, "kamino_redeem", "Redeem Kamino shares into Safe USDC", tables, 400_000);
  return { ...plan, scope: "kamino_usdc", phase: "redeem", sharesBeforeRaw: String(available), targetSharesRaw: String(target), legSharesRaw: String(leg.shares), remainingTargetSharesRaw: String(target - leg.shares), destination: String(a.ata), performanceFeeBps: cfg.performance_fee_bps, allocationBpsAfter: state.allocationBps,
    next: { endpoint: "/api/mobile/v1/protocols/kamino/withdrawals/plan", phase: "return", redemptionSignature: "confirmed redemption transaction signature" },
  };
}

/** Read confirmed balance deltas, after performance fees, before building a partial return. */
export async function kaminoReturnPlan(connection: Connection, network: MobileNetwork, owner: PublicKey, signature: unknown) {
  try { if (typeof signature !== "string" || bs58.decode(signature).length !== 64) throw new Error(); } catch { return fail("INVALID_SIGNATURE", "Expected a Solana transaction signature", 400); }
  if (network.cluster !== "mainnet") fail("PROTOCOL_UNAVAILABLE", "This Kamino route is supported only on Solana Mainnet", 409);
  // Verify the RPC cluster before reading a receipt, including an empty/unavailable receipt.
  if (await connection.getGenesisHash() !== network.genesis) fail("RPC_CLUSTER_MISMATCH", "Configured RPC points to a different Solana cluster");
  const receipt = await connection.getTransaction(signature as string, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!receipt) fail("REDEMPTION_NOT_CONFIRMED", "Receipt is not available yet; keep checking the original signature", 409);
  const meta = receipt.meta, message = receipt.transaction.message;
  const a = safeAddresses(owner, network);
  const keys = message.getAccountKeys({ accountKeysFromLookups: meta?.loadedAddresses });
  const safeIxs = message.compiledInstructions.filter((ix) => keys.get(ix.programIdIndex)?.equals(a.program));
  const ix = safeIxs[0], decoded = ix ? instructionCoder.decode(Buffer.from(ix.data)) : null;
  const supportedOuter = message.compiledInstructions.every((instruction) => {
    const program = keys.get(instruction.programIdIndex);
    return program?.equals(a.program) || program?.equals(ComputeBudgetProgram.programId) ||
      (program?.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && !keys.get(instruction.accountKeyIndexes[1])?.equals(a.ata));
  });
  if (!meta || meta.err || !supportedOuter || message.header.numRequiredSignatures !== 1 || !keys.get(0)?.equals(owner) || safeIxs.length !== 1 || decoded?.name !== "kamino_withdraw" || !keys.get(ix.accountKeyIndexes[0])?.equals(owner) || !keys.get(ix.accountKeyIndexes[1])?.equals(a.safe)) fail("INVALID_REDEMPTION", "Receipt must be a successful owner Kamino redemption for this Safe", 422);
  const deltaFor = (account: PublicKey, mint: PublicKey) => {
    const index = Array.from({ length: keys.length }, (_, i) => i).find((i) => keys.get(i)?.equals(account));
    const balance = (list: typeof meta.preTokenBalances) => list?.find((b) => b.accountIndex === index && b.mint === String(mint) && b.owner === String(a.safe));
    const before = balance(meta.preTokenBalances), after = balance(meta.postTokenBalances);
    if (!before || !after) return fail("INVALID_REDEMPTION", "Receipt token balances are incomplete", 422);
    return BigInt(after.uiTokenAmount.amount) - BigInt(before.uiTokenAmount.amount);
  };
  const net = deltaFor(a.ata, a.mint);
  const burned = -deltaFor(getAssociatedTokenAddressSync(new PublicKey(MOBILE_KAMINO.sharesMint), a.safe, true), new PublicKey(MOBILE_KAMINO.sharesMint));
  if (burned <= BigInt(0) || net < BigInt(0)) fail("INVALID_REDEMPTION", "Receipt has invalid USDC or shares deltas", 422);
  if (net === BigInt(0)) return { status: "empty" as const, scope: "kamino_usdc", phase: "return", redemptionSignature: signature, burnedSharesRaw: String(burned), netUsdc: "0.000000", steps: [] };
  // Confirmed-state transfer cannot be simulated at a slot preceding the receipt.
  const inspected = await inspectSafe(connection, network, owner);
  if (inspected.state.slot < receipt.slot) fail("RPC_BEHIND_REDEMPTION", "RPC state is behind the redemption receipt; retry later", 409);
  const plan = await usdcTransferPlan(connection, network, owner, "withdraw", usdc(net), receipt.slot);
  return { ...plan, scope: "kamino_usdc", phase: "return", redemptionSignature: signature, burnedSharesRaw: String(burned), netUsdc: usdc(net) };
}

/** Wallet -> idle Safe USDC, or idle Safe USDC -> the same owner's canonical ATA. */
export async function usdcTransferPlan(connection: Connection, network: MobileNetwork, owner: PublicKey, kind: "deposit" | "withdraw", input: unknown, minSlot = 0) {
  // Parse input before any RPC access. "all" is only valid for withdrawal.
  const requested = kind === "withdraw" && input === "all" ? null : usdcAmount(input);
  const inspected = await inspectSafe(connection, network, owner);
  const { state, addresses: a, infos, balanceUsdc, walletUsdc } = inspected;
  if (state.slot < minSlot) fail("RPC_BEHIND_REDEMPTION", "RPC state is behind the redemption receipt; retry later", 409);
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
