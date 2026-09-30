import test from "node:test";
import assert from "node:assert/strict";
import { BorshAccountsCoder, BorshInstructionCoder, BN } from "@coral-xyz/anchor";
import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID, AccountState } from "@solana/spl-token";
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import idl from "../src/idl/yield_vault.json" with { type: "json" };
import { creationPlan, inspectSafe, MOBILE_NETWORKS, solanaOwner, safeAddresses, requireCluster, SAFE_SPACE, LIMITS_SPACE } from "../src/lib/mobileSafe.ts";

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
    info(mint, TOKEN_PROGRAM_ID), null, null, null,
  ];
  const calls = [];
  const connection = {
    getGenesisHash: async () => network.genesis,
    getMultipleAccountsInfoAndContext: async (keys) => { assert.deepEqual(keys.map(String), [addresses.program, addresses.registry, addresses.mint, addresses.safe, addresses.limits, addresses.ata].map(String)); return { context: { slot: 42 }, value: accounts }; },
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
function setAta(f, mint = addresses.mint, authority = addresses.safe) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint, owner: authority, amount: BigInt(1_000_001), delegateOption: 0, delegate: PublicKey.default, state: AccountState.Initialized, isNativeOption: 0, isNative: BigInt(0), delegatedAmount: BigInt(0), closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  f.accounts[5] = info(data, TOKEN_PROGRAM_ID);
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
