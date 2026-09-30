import test from "node:test";
import assert from "node:assert/strict";
import { BorshAccountsCoder, BorshInstructionCoder, BN } from "@coral-xyz/anchor";
import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID, AccountState } from "@solana/spl-token";
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import idl from "../src/idl/yield_vault.json" with { type: "json" };
import { creationPlan, inspectSafe, MOBILE_NETWORKS, solanaOwner, safeAddresses, requireCluster, SAFE_SPACE, LIMITS_SPACE, usdcTransferPlan, usdcAmount } from "../src/lib/mobileSafe.ts";

const network = MOBILE_NETWORKS.devnet;
const owner = new PublicKey("2twCpxj6cqztdXwgV7EabmtDnC7W7xGr12hNrEuxpcdj");
const executor = new PublicKey("3ayNPp7MoihfbnTQ4q6Ge5PVNe9tJsY5betKqKX7C8aH");
const other = new PublicKey("EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2");
const addresses = safeAddresses(owner, network);
const coder = new BorshAccountsCoder(idl);
const ixCoder = new BorshInstructionCoder(idl);
const info = (data, program = addresses.program, lamports = 1_000_000) => ({ data, owner: program, lamports, executable: false, rentEpoch: 0 });
const padded = (data, size) => Buffer.concat([data, Buffer.alloc(size - data.length)]);
async function fixture() {
  const mint = Buffer.alloc(MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: BigInt(999), decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mint);
  const accounts = [
    { ...info(Buffer.alloc(0), new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111")), executable: true },
    info(await coder.encode("ExecutorRegistry", { bump: addresses.registryBump, default_executor: executor, approved: [executor] })),
    info(mint, TOKEN_PROGRAM_ID), null, null, null, null,
  ];
  const calls = [];
  const connection = {
    getGenesisHash: async () => network.genesis,
    getMultipleAccountsInfoAndContext: async (keys) => { assert.deepEqual(keys.map(String), [addresses.program, addresses.registry, addresses.mint, addresses.safe, addresses.limits, addresses.ata, addresses.ownerAta].map(String)); return { context: { slot: 42 }, value: accounts }; },
    getBalance: async () => 1_000_000_000,
    getMinimumBalanceForRentExemption: async (size) => { calls.push(size); return size * 6960 + 890880; },
    getLatestBlockhash: async () => ({ blockhash: other.toBase58(), lastValidBlockHeight: 567 }),
    getFeeForMessage: async () => ({ value: 5000 }),
    simulateTransaction: async (tx, options) => { assert.equal(options.sigVerify, false); assert.equal(options.minContextSlot, 42); assert.ok(tx.signatures.every((sig) => sig.every((byte) => byte === 0))); return { context: { slot: 44 }, value: { err: null, unitsConsumed: 79000 } }; },
  };
  return { accounts, calls, connection };
}
async function setVault(f, wallet = owner) {
  f.accounts[3] = info(padded(await coder.encode("Vault", { bump: addresses.safeBump, owner: wallet, agent: executor, allocation_bps: [5000,0,0,0,0,0,0,0], last_rebalance_ts: new BN(1), allowed_programs: [], route_principal: Array.from({ length: 8 }, () => new BN(0)) }), SAFE_SPACE));
}
function setAta(f, mint = addresses.mint, authority = addresses.safe, index = 5, amount = BigInt(1_000_001)) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint, owner: authority, amount, delegateOption: 0, delegate: PublicKey.default, state: AccountState.Initialized, isNativeOption: 0, isNative: BigInt(0), delegatedAmount: BigInt(0), closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  f.accounts[index] = info(data, TOKEN_PROGRAM_ID);
}
const rejects = (action, code) => assert.rejects(action, (err) => err.code === code);

test("owner and cluster validation rejects EVM, PDAs, noncanonical addresses and wrong cluster", () => {
  assert.equal(solanaOwner({ type: "solana", address: String(owner) }).toBase58(), String(owner));
  for (const invalid of [{ type: "evm", address: "0x123" }, { type: "solana", address: String(addresses.safe) }, { type: "solana", address: ` ${owner}` }, { type: "solana", address: String(owner), executor: String(other) }]) assert.throws(() => solanaOwner(invalid));
  assert.throws(() => requireCluster("mainnet", network));
  assert.notEqual(safeAddresses(owner, MOBILE_NETWORKS.mainnet).safe.toBase58(), addresses.safe.toBase58());
});
test("one unsigned creation transaction binds owner, payer, program, ATA, approved executor and safe defaults", async () => {
  const f = await fixture();
  const plan = await creationPlan(f.connection, network, owner);
  assert.equal(plan.status, "ready");
  assert.equal(plan.steps.length, 1);
  assert.deepEqual(f.calls, [SAFE_SPACE, LIMITS_SPACE, 165]);
  assert.equal(plan.cost.totalLamports, "11781320");
  const tx = VersionedTransaction.deserialize(Buffer.from(plan.steps[0].transaction, "base64"));
  assert.equal(tx.message.header.numRequiredSignatures, 1);
  assert.ok(tx.signatures[0].every((byte) => byte === 0));
  assert.equal(tx.message.staticAccountKeys[0].toBase58(), String(owner));
  const decoded = TransactionMessage.decompile(tx.message);
  assert.equal(decoded.instructions.length, 2);
  assert.ok(decoded.instructions[0].programId.equals(ComputeBudgetProgram.programId));
  const ix = decoded.instructions[1];
  assert.equal(String(ix.programId), network.programId);
  assert.deepEqual(ix.keys.map((meta) => String(meta.pubkey)), [owner, addresses.safe, addresses.registry, addresses.mint, addresses.ata, TOKEN_PROGRAM_ID, new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"), SystemProgram.programId, addresses.limits].map(String));
  assert.deepEqual(ix.keys.filter((meta) => meta.isSigner).map((meta) => String(meta.pubkey)), [String(owner)]);
  const instruction = ixCoder.decode(ix.data);
  assert.equal(instruction.name, "initialize_with_limits");
  assert.equal(String(instruction.data.agent), String(executor));
  assert.deepEqual(instruction.data.allocation_bps, Array(8).fill(0));
  assert.deepEqual(instruction.data.allowed_programs, []);
  assert.equal(plan.defaults.executorLimits.max24hVolumeUsdc, "1000.000000");
  assert.equal(plan.lastValidBlockHeight, 567);
});
test("initialized Safe is returned without new rent, simulation or transaction", async () => {
  const f = await fixture(); await setVault(f); setAta(f);
  const plan = await creationPlan(f.connection, network, owner);
  assert.equal(plan.status, "already_exists"); assert.deepEqual(plan.steps, []);
  assert.equal(plan.state.idleUsdc, "1.000001"); assert.deepEqual(f.calls, []);
});
test("cluster, unavailable program, wrong registry owner and discriminator fail closed", async () => {
  const f = await fixture();
  f.connection.getGenesisHash = async () => MOBILE_NETWORKS.mainnet.genesis;
  await rejects(() => creationPlan(f.connection, network, owner), "RPC_CLUSTER_MISMATCH");
  f.connection.getGenesisHash = async () => network.genesis;
  f.accounts[0].executable = false;
  await rejects(() => creationPlan(f.connection, network, owner), "PROGRAM_UNAVAILABLE");
  f.accounts[0].executable = true; f.accounts[1].owner = SystemProgram.programId;
  await rejects(() => creationPlan(f.connection, network, owner), "INVALID_ACCOUNT");
  f.accounts[1].owner = addresses.program; f.accounts[1].data[0] ^= 1;
  await rejects(() => creationPlan(f.connection, network, owner), "INVALID_ACCOUNT");
});
test("unapproved default executor cannot create a Safe", async () => {
  const f = await fixture();
  f.accounts[1] = info(await coder.encode("ExecutorRegistry", { bump: addresses.registryBump, default_executor: other, approved: [executor] }));
  await rejects(() => creationPlan(f.connection, network, owner), "EXECUTOR_UNAVAILABLE");
});
test("Safe owner and token mint/authority substitution are rejected", async () => {
  const f = await fixture(); await setVault(f, other);
  await rejects(() => inspectSafe(f.connection, network, owner), "INVALID_ACCOUNT");
  f.accounts[3] = null; setAta(f, other);
  await rejects(() => creationPlan(f.connection, network, owner), "INVALID_ACCOUNT");
  setAta(f, addresses.mint, other);
  await rejects(() => creationPlan(f.connection, network, owner), "INVALID_ACCOUNT");
});
test("insufficient SOL includes funding cost and never returns a transaction", async () => {
  const f = await fixture(); f.connection.getBalance = async () => 0;
  await assert.rejects(() => creationPlan(f.connection, network, owner), (err) => err.code === "INSUFFICIENT_SOL" && err.status === 422 && err.details.cost.totalLamports === "11781320");
});
test("ATA rent is excluded when present; prefunded PDA rent uses only the top-up", async () => {
  const f = await fixture(); setAta(f);
  const full = await creationPlan(f.connection, network, owner);
  assert.equal(full.cost.totalLamports, "9742040");
  f.accounts[3] = info(Buffer.alloc(0), SystemProgram.programId, 100_000);
  const partial = await creationPlan(f.connection, network, owner);
  assert.equal(partial.cost.totalLamports, "9642040");
});
test("orphan executor policy cannot be reused/reset", async () => {
  const f = await fixture();
  f.accounts[4] = info(await coder.encode("ExecutorLimits", { vault: addresses.safe, bump: addresses.limitsBump, enabled: false, max_action_usdc: new BN(1), max_24h_volume_usdc: new BN(1), max_principal_usdc: new BN(1), hour_epoch: Array.from({ length: 25 }, () => new BN(0)), hour_volume: Array.from({ length: 25 }, () => new BN(0)) }));
  await rejects(() => creationPlan(f.connection, network, owner), "INVALID_ACCOUNT");
});
test("expired fee lookup and failed unsigned simulation do not produce a plan", async () => {
  const f = await fixture(); f.connection.getFeeForMessage = async () => ({ value: null });
  await rejects(() => creationPlan(f.connection, network, owner), "BLOCKHASH_UNAVAILABLE");
  f.connection.getFeeForMessage = async () => ({ value: 5000 });
  f.connection.simulateTransaction = async () => ({ context: { slot: 44 }, value: { err: { InstructionError: [1, "Custom"] } } });
  await rejects(() => creationPlan(f.connection, network, owner), "SIMULATION_FAILED");
});

test("amount parsing is exact at six decimals and u64 boundary", () => {
  assert.equal(usdcAmount("0.000001"), BigInt(1));
  assert.equal(usdcAmount("1000.5"), BigInt(1_000_500_000));
  assert.equal(usdcAmount("18446744073709.551615"), (BigInt(1) << BigInt(64)) - BigInt(1));
  for (const amount of [0, -1, "0", "0.000000", "1e3", "-1", "01", " 1", ".5", "1.", "1.0000001", "18446744073709.551616", "all"]) assert.throws(() => usdcAmount(amount));
});
test("deposit and partial withdrawal bind exact amounts, owner signer and canonical USDC accounts", async () => {
  const f = await fixture(); await setVault(f); setAta(f); setAta(f, addresses.mint, owner, 6, BigInt(2_000_000));
  for (const kind of ["deposit", "withdraw"]) {
    const plan = await usdcTransferPlan(f.connection, network, owner, kind, "0.100001");
    assert.equal(plan.amountRaw, "100001"); assert.equal(plan.amount, "0.100001");
    assert.equal(plan.scope, "idle_usdc"); assert.equal(plan.cost.rentLamports, "0");
    assert.equal(plan.steps.length, 1); assert.equal(plan.cost.feePayer, String(owner));
    const tx = VersionedTransaction.deserialize(Buffer.from(plan.steps[0].transaction, "base64"));
    assert.equal(tx.message.header.numRequiredSignatures, 1); assert.ok(tx.signatures[0].every((byte) => byte === 0));
    const instructions = TransactionMessage.decompile(tx.message).instructions;
    assert.equal(instructions.length, 2);
    const ix = instructions[1]; const decoded = ixCoder.decode(ix.data);
    assert.equal(decoded.name, kind); assert.equal(decoded.data.amount.toString(), "100001");
    assert.deepEqual(ix.keys.map((key) => String(key.pubkey)), [owner, addresses.safe, addresses.mint, addresses.ownerAta, addresses.ata, TOKEN_PROGRAM_ID].map(String));
    assert.equal(plan.destination, String(kind === "deposit" ? addresses.ata : addresses.ownerAta));
    assert.equal(plan.state.allocationBps[0], 5000); // Wallet ingress/egress never changes allocation.
  }
});
test("full idle withdrawal uses the snapshot balance and creates missing owner ATA atomically", async () => {
  const f = await fixture(); await setVault(f); setAta(f);
  const plan = await usdcTransferPlan(f.connection, network, owner, "withdraw", "all");
  assert.equal(plan.amountRaw, "1000001"); assert.equal(plan.allIdleAtPlanTime, true);
  assert.equal(plan.cost.rentLamports, "2039280");
  const instructions = TransactionMessage.decompile(VersionedTransaction.deserialize(Buffer.from(plan.steps[0].transaction, "base64")).message).instructions;
  assert.equal(instructions.length, 3);
  assert.equal(String(instructions[1].programId), "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  assert.equal(String(instructions[1].keys[1].pubkey), String(addresses.ownerAta));
  assert.equal(ixCoder.decode(instructions[2].data).name, "withdraw");
});
test("deposit recreates missing Safe ATA in the owner transaction", async () => {
  const f = await fixture(); await setVault(f); setAta(f, addresses.mint, owner, 6);
  const plan = await usdcTransferPlan(f.connection, network, owner, "deposit", "1");
  const instructions = TransactionMessage.decompile(VersionedTransaction.deserialize(Buffer.from(plan.steps[0].transaction, "base64")).message).instructions;
  assert.equal(String(instructions[1].keys[1].pubkey), String(addresses.ata));
  assert.equal(String(instructions[1].keys[2].pubkey), String(addresses.safe));
  assert.equal(plan.cost.rentLamports, "2039280");
});
test("missing Safe, insufficient wallet/Safe USDC and insufficient SOL fail before signing", async () => {
  const f = await fixture();
  await rejects(() => usdcTransferPlan(f.connection, network, owner, "deposit", "1"), "SAFE_NOT_CREATED");
  await setVault(f); setAta(f); setAta(f, addresses.mint, owner, 6);
  await rejects(() => usdcTransferPlan(f.connection, network, owner, "deposit", "2"), "INSUFFICIENT_USDC");
  await rejects(() => usdcTransferPlan(f.connection, network, owner, "withdraw", "2"), "INSUFFICIENT_USDC");
  f.connection.getBalance = async () => 0;
  await rejects(() => usdcTransferPlan(f.connection, network, owner, "withdraw", "1"), "INSUFFICIENT_SOL");
});
test("empty full withdrawal returns no transaction; owner ATA substitution is rejected", async () => {
  const f = await fixture(); await setVault(f);
  const empty = await usdcTransferPlan(f.connection, network, owner, "withdraw", "all");
  assert.equal(empty.status, "empty"); assert.deepEqual(empty.steps, []);
  setAta(f, addresses.mint, other, 6);
  await rejects(() => usdcTransferPlan(f.connection, network, owner, "deposit", "1"), "INVALID_ACCOUNT");
});
test("transfer simulation failure produces no payload", async () => {
  const f = await fixture(); await setVault(f); setAta(f); setAta(f, addresses.mint, owner, 6);
  f.connection.simulateTransaction = async () => ({ context: { slot: 44 }, value: { err: "AccountNotFound" } });
  await rejects(() => usdcTransferPlan(f.connection, network, owner, "withdraw", "1"), "SIMULATION_FAILED");
});
