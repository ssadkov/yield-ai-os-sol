import test from "node:test";
import assert from "node:assert/strict";
import { BorshAccountsCoder, BorshInstructionCoder, BN } from "@coral-xyz/anchor";
import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID, AccountState, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { AddressLookupTableAccount, PublicKey, TransactionMessage, VersionedTransaction, SystemProgram } from "@solana/web3.js";
import idl from "../src/idl/yield_vault_mobile.json" with { type: "json" };
import { MOBILE_NETWORKS, MOBILE_KAMINO, safeAddresses, kaminoDepositPlan, checkedKaminoDeposit, kaminoWithdrawalPlan, kaminoReturnPlan, checkedKaminoWithdrawal } from "../src/lib/mobileSafe.ts";
import bs58 from "bs58";

const network = MOBILE_NETWORKS.mainnet;
const owner = new PublicKey("EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2");
const other = new PublicKey("2twCpxj6cqztdXwgV7EabmtDnC7W7xGr12hNrEuxpcdj");
const executor = new PublicKey("3ayNPp7MoihfbnTQ4q6Ge5PVNe9tJsY5betKqKX7C8aH");
const a = safeAddresses(owner, network);
const sharesMint = new PublicKey(MOBILE_KAMINO.sharesMint);
const sharesAta = getAssociatedTokenAddressSync(sharesMint, a.safe, true);
const coder = new BorshAccountsCoder(idl), ixCoder = new BorshInstructionCoder(idl);
const info = (data, program = a.program, lamports = 2_000_000) => ({ data, owner: program, lamports, executable: false, rentEpoch: 0 });
const executable = () => ({ ...info(Buffer.alloc(0), new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111")), executable: true });
function mintInfo() {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: BigInt(100_000_000), decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
  return info(data, TOKEN_PROGRAM_ID);
}
function tokenInfo(mint, authority, amount = BigInt(10_000_000)) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint, owner: authority, amount, delegateOption: 0, delegate: PublicKey.default, state: AccountState.Initialized, isNativeOption: 0, isNative: BigInt(0), delegatedAmount: BigInt(0), closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  return info(data, TOKEN_PROGRAM_ID);
}
function payload() {
  const keys = [a.safe, new PublicKey(MOBILE_KAMINO.vault), other, a.mint, other, sharesMint, a.ata, sharesAta,
    new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"), TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, other, new PublicKey(MOBILE_KAMINO.program)];
  const data = Buffer.alloc(16); Buffer.from("f223c68952e1f2b6", "hex").copy(data); data.writeBigUInt64LE(BigInt(1_000_000), 8);
  return { instructions: [{ programAddress: MOBILE_KAMINO.program, data: data.toString("base64"), accounts: keys.map((key, index) => ({ address: String(key), role: index === 0 ? "WRITABLE_SIGNER" : [1,2,5,6,7].includes(index) ? "WRITABLE" : "READONLY" })) }], lutsByAddress: {} };
}
async function fixture(allocation = [5000,0,0,0,0,0,0,0]) {
  const accounts = [executable(), info(await coder.encode("ExecutorRegistry", { bump: a.registryBump, default_executor: executor, approved: [executor] })), mintInfo(),
    info(await coder.encode("Vault", { bump: a.safeBump, owner, agent: executor, allocation_bps: allocation, last_rebalance_ts: new BN(1), allowed_programs: [], route_principal: Array.from({ length: 8 }, () => new BN(0)) })),
    null, tokenInfo(a.mint, a.safe), tokenInfo(a.mint, owner)];
  const kamino = [executable(), info(Buffer.alloc(100), new PublicKey(MOBILE_KAMINO.program)), mintInfo(), tokenInfo(sharesMint, a.safe)];
  const f = { accounts, kamino, payload: payload(), fetched: 0, tables: new Map(), tx: null };
  f.connection = {
    getGenesisHash: async () => network.genesis,
    getMultipleAccountsInfoAndContext: async (keys, config) => {
      const protocol = keys[0].toBase58() === MOBILE_KAMINO.program;
      assert.deepEqual(keys.map(String), protocol ? [MOBILE_KAMINO.program, MOBILE_KAMINO.vault, sharesMint, sharesAta].map(String) : [a.program, a.registry, a.mint, a.safe, a.limits, a.ata, a.ownerAta].map(String));
      if (protocol) assert.equal(config.minContextSlot, 42);
      return { context: { slot: protocol ? 44 : 42 }, value: protocol ? kamino : accounts };
    },
    getBalance: async () => 100_000_000,
    getMinimumBalanceForRentExemption: async () => 2_039_280,
    getLatestBlockhash: async () => ({ blockhash: String(other), lastValidBlockHeight: 567 }),
    getFeeForMessage: async () => ({ value: 5000 }),
    getAddressLookupTable: async (key) => ({ value: f.tables.get(String(key)) ?? null }),
    simulateTransaction: async (tx, config) => {
      assert.equal(config.sigVerify, false); assert.equal(config.minContextSlot, 44);
      assert.equal(tx.message.header.numRequiredSignatures, 1);
      assert.ok(tx.signatures.every((sig) => sig.every((b) => b === 0)));
      f.tx = tx;
      return { context: { slot: 45 }, value: { err: null, unitsConsumed: 168_000 } };
    },
  };
  f.fetcher = async (url, options) => {
    f.fetched++;
    assert.equal(url, "https://api.kamino.finance/ktx/kvault/deposit-instructions");
    assert.deepEqual(JSON.parse(options.body), { wallet: String(a.safe), kvault: MOBILE_KAMINO.vault, amount: "1.000000" });
    return Response.json(f.payload);
  };
  return f;
}
const plan = (f, source = "safe", amount = "1") => kaminoDepositPlan(f.connection, network, owner, source, amount, f.fetcher);
const rejects = (action, code) => assert.rejects(action, (err) => err.code === code);
const instructions = (p, tables = []) => TransactionMessage.decompile(VersionedTransaction.deserialize(Buffer.from(p.steps[0].transaction, "base64")).message, { addressLookupTableAccounts: tables }).instructions;

test("both sources are atomic, owner-signed, preserve allocation and use only typed Kamino CPI", async () => {
  for (const source of ["safe", "wallet"]) {
    const f = await fixture(), p = await plan(f, source);
    assert.equal(p.steps.length, 1); assert.equal(p.atomic, true); assert.equal(p.scope, "kamino_usdc");
    assert.equal(p.cost.totalLamports, "5000"); assert.deepEqual(p.steps[0].requiredSigners, [String(owner)]);
    assert.equal(p.sourceAccount, String(source === "wallet" ? a.ownerAta : a.ata));
    assert.equal(p.destinationSharesAta, String(sharesAta)); assert.equal(p.amountRaw, "1000000");
    const ixs = instructions(p);
    const safeIxs = ixs.filter((ix) => ix.programId.equals(a.program));
    const decoded = safeIxs.map((ix) => ixCoder.decode(ix.data));
    assert.deepEqual(decoded.map((ix) => ix.name), source === "wallet" ? ["set_allocation", "deposit", "kamino_deposit", "set_allocation"] : ["set_allocation", "kamino_deposit", "set_allocation"]);
    assert.deepEqual(decoded[0].data.allocation_bps, [10000,0,0,0,0,0,0,0]);
    assert.deepEqual(decoded.at(-1).data.allocation_bps, p.state.allocationBps);
    const deposit = safeIxs.find((ix) => ixCoder.decode(ix.data).name === "kamino_deposit");
    assert.equal(String(ixCoder.decode(deposit.data).data.amount), "1000000");
    assert.deepEqual(deposit.keys.slice(0, 4).map((m) => String(m.pubkey)), [owner, a.safe, a.registry, new PublicKey(MOBILE_KAMINO.program)].map(String));
    assert.ok(!deposit.keys.some((m) => m.pubkey.equals(a.limits)));
    assert.ok(ixs.every((ix) => !ix.programId.equals(new PublicKey(MOBILE_KAMINO.program))));
  }
});
test("already 100% Kamino allocation requires no temporary settings; other routes are restored", async () => {
  const f = await fixture([10000,0,0,0,0,0,0,0]);
  assert.deepEqual(instructions(await plan(f)).filter((ix) => ix.programId.equals(a.program)).map((ix) => ixCoder.decode(ix.data).name), ["kamino_deposit"]);
  const mixed = await fixture([4000,2500,0,0,0,0,0,0]);
  assert.deepEqual((await plan(mixed)).allocationBpsAfter, [4000,2500,0,0,0,0,0,0]);
});
test("missing Safe and shares ATAs are created in the same transaction and rent is quoted", async () => {
  const f = await fixture(); f.accounts[5] = null; f.kamino[3] = null;
  const p = await plan(f, "wallet");
  assert.equal(p.cost.rentLamports, "4078560");
  const atas = instructions(p).filter((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
  assert.equal(atas.length, 2);
  assert.deepEqual(atas.map((ix) => String(ix.keys[1].pubkey)), [a.ata, sharesAta].map(String));
  assert.ok(atas.every((ix) => ix.keys[0].pubkey.equals(owner) && ix.keys[2].pubkey.equals(a.safe)));
  f.kamino[3] = info(Buffer.alloc(0), SystemProgram.programId, 1000);
  assert.equal((await plan(f, "wallet")).cost.rentLamports, "4077560");
});
test("cluster, source, decimal precision and minimum fail before RPC or KTX", async () => {
  const f = await fixture();
  await rejects(() => kaminoDepositPlan({}, MOBILE_NETWORKS.devnet, owner, "safe", "1", f.fetcher), "PROTOCOL_UNAVAILABLE");
  await rejects(() => plan(f, "executor"), "INVALID_SOURCE");
  await rejects(() => plan(f, "safe", "1.0000001"), "INVALID_AMOUNT");
  await rejects(() => plan(f, "safe", "0.999999"), "AMOUNT_BELOW_MINIMUM");
  assert.equal(f.fetched, 0);
});
test("missing Safe, insufficient selected balance and missing SOL return no transaction", async () => {
  const f = await fixture(); f.accounts[3] = null;
  await rejects(() => plan(f), "SAFE_NOT_CREATED");
  const low = await fixture(); low.accounts[5] = tokenInfo(a.mint, a.safe, BigInt(0));
  await rejects(() => plan(low), "INSUFFICIENT_USDC");
  low.accounts[6] = tokenInfo(a.mint, owner, BigInt(0));
  await rejects(() => plan(low, "wallet"), "INSUFFICIENT_USDC");
  assert.equal(low.fetched, 0);
  const noSol = await fixture(); noSol.connection.getBalance = async () => 0;
  await rejects(() => plan(noSol), "INSUFFICIENT_SOL");
});
test("untrusted Kamino payload cannot substitute amount, route, recipient, signer or token program", async () => {
  const mutate = [
    (p) => p.instructions.push(structuredClone(p.instructions[0])),
    (p) => { const data = Buffer.from(p.instructions[0].data, "base64"); data[0] ^= 1; p.instructions[0].data = data.toString("base64"); },
    (p) => { const data = Buffer.from(p.instructions[0].data, "base64"); data.writeBigUInt64LE(BigInt(2_000_000), 8); p.instructions[0].data = data.toString("base64"); },
    ...[0,1,3,5,6,7,8,9,10,12].map((index) => (p) => { p.instructions[0].accounts[index].address = String(other); }),
    (p) => { p.instructions[0].accounts[2].role = "WRITABLE_SIGNER"; },
    (p) => { p.instructions[0].accounts[6].role = "UNKNOWN"; },
    (p) => { p.instructions[0].accounts.push({ address: String(owner), role: "READONLY" }); },
    (p) => { p.instructions[0].accounts.push({ address: String(a.safe), role: "READONLY" }); },
    (p) => { p.instructions[0].accounts[0].role = "READONLY_SIGNER"; },
    (p) => { p.lutsByAddress = { bad: [] }; },
  ];
  for (const change of mutate) {
    const p = payload(); change(p);
    assert.throws(() => checkedKaminoDeposit(p, a.safe, owner, BigInt(1_000_000)), (err) => err.code === "INVALID_KAMINO_RESPONSE");
  }
});
test("KTX setup and farm instructions are not forwarded to the owner", async () => {
  const f = await fixture();
  f.payload.instructions.unshift({ programAddress: String(SystemProgram.programId), data: "arbitrary", accounts: [] });
  const p = await plan(f);
  assert.ok(instructions(p).every((ix) => !ix.programId.equals(SystemProgram.programId)));
});
test("shares authority/mint/state and protocol ownership are checked before simulation", async () => {
  const wrongShares = await fixture(); wrongShares.kamino[3] = tokenInfo(sharesMint, other);
  await rejects(() => plan(wrongShares), "INVALID_ACCOUNT");
  const wrongMint = await fixture(); wrongMint.kamino[3] = tokenInfo(a.mint, a.safe);
  await rejects(() => plan(wrongMint), "INVALID_ACCOUNT");
  const wrongProgram = await fixture(); wrongProgram.kamino[0].executable = false;
  await rejects(() => plan(wrongProgram), "PROTOCOL_UNAVAILABLE");
  const wrongVault = await fixture(); wrongVault.kamino[1].owner = SystemProgram.programId;
  await rejects(() => plan(wrongVault), "PROTOCOL_UNAVAILABLE");
});
test("lookup tables are loaded from RPC instead of trusting KTX-supplied addresses", async () => {
  const f = await fixture(); f.payload.lutsByAddress[String(other)] = [String(owner)];
  await rejects(() => plan(f), "LOOKUP_TABLE_UNAVAILABLE");
  const table = new AddressLookupTableAccount({ key: other, state: { deactivationSlot: (BigInt(1) << BigInt(64)) - BigInt(1), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [a.ata, sharesAta, sharesMint, a.safe] } });
  f.tables.set(String(other), table);
  const p = await plan(f);
  assert.ok(f.tx.message.addressTableLookups.length > 0);
  assert.ok(instructions(p, [table]).some((ix) => ixCoder.decode(ix.data)?.name === "kamino_deposit"));
  table.state.deactivationSlot = BigInt(1);
  await rejects(() => plan(f), "LOOKUP_TABLE_UNAVAILABLE");
});
test("failed unsigned simulation and upstream errors return no signed/sendable plan", async () => {
  const f = await fixture(); f.connection.simulateTransaction = async () => ({ context: { slot: 45 }, value: { err: { InstructionError: [1, "Custom"] } } });
  await rejects(() => plan(f), "SIMULATION_FAILED");
  f.fetcher = async () => { throw new Error("secret RPC URL"); };
  await rejects(() => plan(f), "KAMINO_UNAVAILABLE");
  f.fetcher = async () => new Response("upstream secret", { status: 500 });
  await rejects(() => plan(f), "KAMINO_UNAVAILABLE");
});

function withdrawalBundle(shares = "5000000", reserve = false) {
  const keys = [a.safe, new PublicKey(MOBILE_KAMINO.vault), other, other, other, a.ata, a.mint, sharesAta, sharesMint, TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"), other, new PublicKey(MOBILE_KAMINO.program)];
  if (reserve) keys.push(new PublicKey(MOBILE_KAMINO.vault), ...Array(9).fill(other), new PublicKey(MOBILE_KAMINO.program));
  return { safe: String(a.safe), withdrawals: [{ shares, discriminator: reserve ? "b712469c946da122" : "1383709baadc2239", accounts: keys.map((key, i) => ({ address: String(key), writable: [1,3,5,6,7,8,14,15,16,19,20].includes(i) })) }], lookupTables: [] };
}
async function withdrawalFixture() {
  const f = await fixture();
  const [config, bump] = PublicKey.findProgramAddressSync([Buffer.from("config")], a.program);
  f.config = info(await coder.encode("Config", { admin: other, treasury: other, performance_fee_bps: 500, bump }));
  f.treasury = tokenInfo(a.mint, other);
  f.bundle = withdrawalBundle();
  const treasuryAta = getAssociatedTokenAddressSync(a.mint, other);
  const originalRead = f.connection.getMultipleAccountsInfoAndContext;
  f.connection.getMultipleAccountsInfoAndContext = async (keys, options) => {
    if (keys.length === 5) { assert.deepEqual(keys.map(String), [MOBILE_KAMINO.program,MOBILE_KAMINO.vault,sharesMint,sharesAta,config].map(String)); return { context: { slot: 44 }, value: [...f.kamino, f.config] }; }
    if (keys.length === 1) { assert.equal(String(keys[0]), String(treasuryAta)); return { context: { slot: 44 }, value: [f.treasury] }; }
    return originalRead(keys, options);
  };
  f.builder = async (safe, target) => { f.target = target; assert.equal(String(safe), String(a.safe)); return f.bundle; };
  return f;
}
const redeem = (f, selection = { percent: "50" }) => kaminoWithdrawalPlan(f.connection, network, owner, selection, f.builder);
test("partial and full redemption use a single bounded typed owner instruction and keep allocation", async () => {
  for (const reserve of [false,true]) {
    const f = await withdrawalFixture(); f.bundle = withdrawalBundle("5000000",reserve);
    const p = await redeem(f);
    assert.equal(p.targetSharesRaw, "5000000"); assert.equal(p.legSharesRaw, "5000000"); assert.equal(p.remainingTargetSharesRaw,"0"); assert.equal(p.destination,String(a.ata)); assert.equal(p.performanceFeeBps,500);
    assert.deepEqual(p.allocationBpsAfter,p.state.allocationBps);
    const typed = instructions(p).filter((ix) => ix.programId.equals(a.program));
    assert.equal(typed.length,1); assert.equal(ixCoder.decode(typed[0].data).name,"kamino_withdraw"); assert.equal(ixCoder.decode(typed[0].data).data.from_reserve,reserve);
    assert.equal(String(ixCoder.decode(typed[0].data).data.shares),"5000000"); assert.ok(!typed[0].keys.some((meta) => meta.pubkey.equals(a.limits)));
  }
  const f = await withdrawalFixture(); f.bundle = withdrawalBundle("18446744073709551615",true);
  const p = await redeem(f,{ shares:"all" }); assert.equal(p.targetSharesRaw,"10000000"); assert.equal(p.legSharesRaw,"10000000");
  // SDK redeem-all cannot consume shares beyond a partial snapshot target.
  assert.equal((await redeem(f,{ shares:"1234567" })).legSharesRaw,"1234567");
});
test("split liquidity returns only the first leg and an exact remaining target, not a repeated percentage", async () => {
  const f = await withdrawalFixture(); f.bundle = withdrawalBundle("2000000"); f.bundle.withdrawals.push(withdrawalBundle("3000000",true).withdrawals[0]);
  const p = await redeem(f); assert.equal(p.legSharesRaw,"2000000"); assert.equal(p.remainingTargetSharesRaw,"3000000"); assert.equal(p.steps.length,1);
  f.treasury=null; assert.equal((await redeem(f)).cost.rentLamports,"2039280");
});
test("withdrawal rejects invalid percentages, shares, insufficient balances and route substitution", async () => {
  const f = await withdrawalFixture();
  for (const selection of [{},{ shares:"all",percent:"50" },{ percent:"0" },{ percent:"100.01" },{ percent:50 },{ percent:"0.001" },{ shares:"0" },{ shares:"18446744073709551616" }]) await assert.rejects(() => redeem(f,selection));
  await rejects(() => redeem(f,{ shares:"10000001" }),"INSUFFICIENT_SHARES");
  await rejects(() => kaminoWithdrawalPlan({},MOBILE_NETWORKS.devnet,owner,{shares:"all"},f.builder),"PROTOCOL_UNAVAILABLE");
  const changes = [(b)=>b.withdrawals[0].shares="5000001",(b)=>b.withdrawals[0].discriminator="wrong",...[0,1,5,6,7,8,9,10,11,13].map(i=>(b)=>b.withdrawals[0].accounts[i].address=String(other)),(b)=>b.withdrawals[0].accounts[2].address=String(owner),(b)=>b.withdrawals[0].accounts[5].writable=false];
  for(const mutate of changes){ const b=withdrawalBundle();mutate(b);assert.throws(()=>checkedKaminoWithdrawal(b,a.safe,owner,BigInt(5000000)),err=>err.code==="INVALID_KAMINO_RESPONSE"); }
});
test("zero shares, tiny percentage, wrong treasury state and failed simulation are explicit",async()=>{
  const f=await withdrawalFixture();f.kamino[3]=tokenInfo(sharesMint,a.safe,BigInt(0));
  const empty=await redeem(f,{shares:"all"});assert.equal(empty.status,"redeemed");assert.equal(empty.steps.length,0);assert.equal(empty.next.amount,"all");
  await rejects(()=>redeem(f,{percent:"50"}),"AMOUNT_BELOW_MINIMUM");
  f.kamino[3]=tokenInfo(sharesMint,a.safe);f.treasury=tokenInfo(a.mint,executor);
  await rejects(()=>redeem(f),"INVALID_ACCOUNT");
  f.treasury=tokenInfo(a.mint,other);f.connection.simulateTransaction=async()=>({context:{slot:45},value:{err:{InstructionError:[2,"Custom"]}}});
  await rejects(()=>redeem(f),"SIMULATION_FAILED");
});
const signature=bs58.encode(new Uint8Array(64).fill(7));
async function receiptFixture(){
  const f=await withdrawalFixture(),p=await redeem(f);
  const message=VersionedTransaction.deserialize(Buffer.from(p.steps[0].transaction,"base64")).message;
  const index=(key)=>message.staticAccountKeys.findIndex(k=>k.equals(key));
  const balance=(key,mint,amount)=>({accountIndex:index(key),mint:String(mint),owner:String(a.safe),uiTokenAmount:{amount:String(amount),decimals:6,uiAmount:null,uiAmountString:"0"}});
  f.receipt={slot:40,transaction:{message,signatures:[signature]},meta:{err:null,loadedAddresses:{writable:[],readonly:[]},preTokenBalances:[balance(a.ata,a.mint,10000000),balance(sharesAta,sharesMint,10000000)],postTokenBalances:[balance(a.ata,a.mint,14999500),balance(sharesAta,sharesMint,5000000)]}};
  f.connection.getTransaction=async()=>f.receipt;
  f.connection.simulateTransaction=async(tx)=>{f.tx=tx;return{context:{slot:45},value:{err:null,unitsConsumed:12000}}};
  return f;
}
test("partial return uses confirmed net USDC after fees and only the same owner's ATA",async()=>{
  const f=await receiptFixture();const p=await kaminoReturnPlan(f.connection,network,owner,signature);
  assert.equal(p.netUsdc,"4.999500");assert.equal(p.amountRaw,"4999500");assert.equal(p.burnedSharesRaw,"5000000");assert.equal(p.destination,String(a.ownerAta));
  const ix=instructions(p).find(ix=>ix.programId.equals(a.program));assert.equal(ixCoder.decode(ix.data).name,"withdraw");assert.equal(String(ixCoder.decode(ix.data).data.amount),"4999500");
});
test("return refuses missing, failed, unrelated, incomplete and stale receipts",async()=>{
  const f=await receiptFixture();await rejects(()=>kaminoReturnPlan(f.connection,network,owner,"bad"),"INVALID_SIGNATURE");
  const good=structuredClone(f.receipt.meta);
  f.receipt.meta.err={InstructionError:[1,"Custom"]};await rejects(()=>kaminoReturnPlan(f.connection,network,owner,signature),"INVALID_REDEMPTION");
  f.receipt.meta=structuredClone(good);f.receipt.meta.postTokenBalances=[];await rejects(()=>kaminoReturnPlan(f.connection,network,owner,signature),"INVALID_REDEMPTION");
  f.receipt.meta=structuredClone(good);f.receipt.slot=100;await rejects(()=>kaminoReturnPlan(f.connection,network,owner,signature),"RPC_BEHIND_REDEMPTION");
  f.receipt=null;await rejects(()=>kaminoReturnPlan(f.connection,network,owner,signature),"REDEMPTION_NOT_CONFIRMED");
  const wrong=await receiptFixture();await rejects(()=>kaminoReturnPlan(wrong.connection,network,other,signature),"INVALID_REDEMPTION");
});
