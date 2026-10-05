import test from "node:test";
import assert from "node:assert/strict";
import { BN, BorshAccountsCoder, BorshInstructionCoder } from "@coral-xyz/anchor";
import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID, AccountState } from "@solana/spl-token";
import { PublicKey, TransactionMessage, VersionedTransaction, SystemProgram } from "@solana/web3.js";
import idl from "../src/idl/yield_vault_mobile.json" with { type: "json" };
import { creationPlan, usdcTransferPlan, MOBILE_NETWORKS, safeAddresses, SAFE_SPACE } from "../src/lib/mobileSafe.ts";
import { checkedMobileTransaction } from "../src/lib/mobileSafeWallet.ts";

const network = MOBILE_NETWORKS.mainnet;
const owner = new PublicKey("EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2");
const executor = new PublicKey("3ayNPp7MoihfbnTQ4q6Ge5PVNe9tJsY5betKqKX7C8aH");
const a = safeAddresses(owner, network);
const coder = new BorshAccountsCoder(idl), ixCoder = new BorshInstructionCoder(idl);
const info = (data, program = a.program) => ({ data, owner: program, lamports: 1_000_000, executable: false, rentEpoch: 0 });
async function fixture(existing = false) {
  const mint = Buffer.alloc(MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 999n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mint);
  const token = authority => {
    const data = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode({ mint: a.mint, owner: authority, amount: 2_000_000n, delegateOption: 0, delegate: PublicKey.default, state: AccountState.Initialized, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
    return info(data, TOKEN_PROGRAM_ID);
  };
  const vault = await coder.encode("Vault", { bump: a.safeBump, owner, agent: executor, allocation_bps: Array(8).fill(0), last_rebalance_ts: new BN(0), allowed_programs: [], route_principal: Array.from({ length: 8 }, () => new BN(0)) });
  const accounts = [
    { ...info(Buffer.alloc(0), new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111")), executable: true },
    info(await coder.encode("ExecutorRegistry", { bump: a.registryBump, default_executor: executor, approved: [executor] })),
    info(mint, TOKEN_PROGRAM_ID), existing ? info(Buffer.concat([vault, Buffer.alloc(SAFE_SPACE - vault.length)])) : null,
    null, existing ? token(a.safe) : null, token(owner),
  ];
  const connection = {
    getGenesisHash: async () => network.genesis,
    getMultipleAccountsInfoAndContext: async () => ({ context: { slot: 123 }, value: accounts }),
    getBalance: async () => 100_000_000,
    getMinimumBalanceForRentExemption: async size => size * 6960 + 890880,
    getLatestBlockhash: async () => ({ blockhash: String(executor), lastValidBlockHeight: 567 }),
    getFeeForMessage: async () => ({ value: 5000 }),
    simulateTransaction: async tx => { assert(tx.signatures.every(s => s.every(b => b === 0))); return { context: { slot: 124 }, value: { err: null, unitsConsumed: 60000 } }; },
  };
  return { accounts, connection };
}
test("Mainnet create plus first deposit binds live program, approved executor, exact USDC and one owner signature", async () => {
  const f = await fixture(); const plan = await creationPlan(f.connection, network, owner, "1");
  assert.equal(plan.state.safe, "FuDCEZBgp8gxP3gafnHbUJRgGW63VAmtZwsjus1U5qSZ");
  assert.equal(plan.atomic, true); assert.equal(plan.cost.feePayer, String(owner));
  const tx = checkedMobileTransaction(plan, owner, "create_deposit", "1", "mainnet");
  assert.equal(tx.message.header.numRequiredSignatures, 1); assert(tx.serialize().length <= 1232);
  const ix = TransactionMessage.decompile(tx.message).instructions;
  assert.equal(ixCoder.decode(ix[1].data).data.agent.toString(), String(executor));
  assert.equal(ixCoder.decode(ix[2].data).data.amount.toString(), "1000000");
  assert.throws(() => checkedMobileTransaction(plan, owner, "create_deposit", "1", "devnet"));
});
test("Mainnet deposit, partial and all idle withdrawal reconstruct exactly and always return to owner", async () => {
  const f = await fixture(true);
  for (const [action, amount] of [["deposit", "1"], ["withdraw", "0.4"], ["withdraw", "all"]]) {
    const plan = await usdcTransferPlan(f.connection, network, owner, action, amount);
    checkedMobileTransaction(plan, owner, action, amount, "mainnet");
    assert.equal(plan.destination, String(action === "withdraw" ? a.ownerAta : a.ata));
    if (amount === "all") assert.equal(plan.amountRaw, "2000000");
  }
});
test("Mainnet missing owner ATA is recreated atomically; existing Safe retry cannot deposit twice", async () => {
  const f = await fixture(true); f.accounts[6] = null;
  const plan = await usdcTransferPlan(f.connection, network, owner, "withdraw", "all");
  checkedMobileTransaction(plan, owner, "withdraw", "all", "mainnet");
  assert.equal(plan.cost.rentLamports, "2039280");
  const repeat = await creationPlan(f.connection, network, owner, "1");
  assert.equal(repeat.status, "already_exists"); assert.deepEqual(repeat.steps, []);
});
test("Mainnet wallet rejects forged amount, recipient, extra transfer, signatures and network", async () => {
  const f = await fixture(true); const plan = await usdcTransferPlan(f.connection, network, owner, "withdraw", "1");
  assert.throws(() => checkedMobileTransaction({ ...plan, amountRaw: "2" }, owner, "withdraw", "1", "mainnet"));
  for (const change of ["recipient", "extra", "signature"]) {
    const tx = VersionedTransaction.deserialize(Buffer.from(plan.steps[0].transaction, "base64"));
    if (change === "signature") tx.signatures[0][0] = 1;
    else {
      const m = TransactionMessage.decompile(tx.message);
      if (change === "recipient") m.instructions[1].keys[3].pubkey = executor;
      else m.instructions.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: executor, lamports: 1 }));
      tx.message = m.compileToV0Message();
    }
    const forged = { ...plan, steps: [{ transaction: Buffer.from(tx.serialize()).toString("base64") }] };
    assert.throws(() => checkedMobileTransaction(forged, owner, "withdraw", "1", "mainnet"));
  }
  const forged = { ...plan, state: { ...plan.state, network: { ...network, usdcMint: MOBILE_NETWORKS.devnet.usdcMint } } };
  assert.throws(() => checkedMobileTransaction(forged, owner, "withdraw", "1", "mainnet"));
});
test("Mainnet planner fails closed on Devnet RPC, revoked executor and rejected simulation", async () => {
  const f = await fixture(); f.connection.getGenesisHash = async () => MOBILE_NETWORKS.devnet.genesis;
  await assert.rejects(() => creationPlan(f.connection, network, owner), e => e.code === "RPC_CLUSTER_MISMATCH");
  f.connection.getGenesisHash = async () => network.genesis;
  f.accounts[1] = info(await coder.encode("ExecutorRegistry", { bump: a.registryBump, default_executor: executor, approved: [] }));
  await assert.rejects(() => creationPlan(f.connection, network, owner), e => e.code === "EXECUTOR_UNAVAILABLE");
  f.accounts[1] = info(await coder.encode("ExecutorRegistry", { bump: a.registryBump, default_executor: executor, approved: [executor] }));
  f.connection.simulateTransaction = async () => ({ context: { slot: 124 }, value: { err: "AccountNotFound" } });
  await assert.rejects(() => creationPlan(f.connection, network, owner), e => e.code === "SIMULATION_FAILED");
});
