/**
 * Orca + generic-CPI fork test. Runs the built Safe ELF against the live Orca Whirlpool and
 * Token-2022 ELFs and a mainnet account snapshot inside LiteSVM. In-process only: no RPC sends,
 * no real keys. Prepare the snapshot with `npm run orca:fork-prepare`.
 *
 * Env: ORCA_FORK_DIR (snapshot dir), SAFE_SO (default ../target/deploy/yield_vault.so),
 *      SAFE_IDL (default ../target/idl/yield_vault.json), PROBE_SO (default
 *      fixtures/cpi-probe/target/deploy/cpi_probe.so).
 */
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { AnchorProvider, BorshAccountsCoder, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, AccountLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import BN from 'bn.js';

const require_ = createRequire(import.meta.url);
const runtime = require_('litesvm'), kit = require_('@solana/kit');
const dir = process.env.ORCA_FORK_DIR; if (!dir) throw Error('ORCA_FORK_DIR required');
const safeSo = process.env.SAFE_SO || new URL('../../target/deploy/yield_vault.so', import.meta.url).pathname;
const idlPath = process.env.SAFE_IDL || new URL('../../target/idl/yield_vault.json', import.meta.url).pathname;
const probeSo = process.env.PROBE_SO || new URL('../fixtures/cpi-probe/target/deploy/cpi_probe.so', import.meta.url).pathname;
const snapshot = JSON.parse(readFileSync(dir + '/snapshot.json', 'utf8'));

// ------------------------------------------------------------------ constants (mirror orca.rs)
const SAFE = new PublicKey('yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih');
const ORCA = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const META_AUTH = new PublicKey('3axbTs2z5GBy6usVbNVoqEgZMng3vZvMnAoX29BFfwhr');
const PROBE = Keypair.generate().publicKey;
const FEEDS = [
  new PublicKey('Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX'), // 0 USDC/USD, max age 120 s
  new PublicKey('4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo'), // 1 BTC/USD, max age 90 s
  new PublicKey('7oqYpv5YbjJ2PEsNeVVB5ZEZ8ZE6ufkj8hAvAiaiftbe'), // 2 cbBTC/USD peg, max age 600 s
  new PublicKey('9gNX5vguzarZZPjTnE1hWze3s6UsZ7dsU3UnAmKPnMHG'), // 3 WBTC/USD peg, max age 600 s
];
const F_USDC = 0, F_BTC = 1, F_CBBTC = 2, F_WBTC = 3;
const ASSETS = [
  { name: 'USDC', mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), decimals: 6, price: F_USDC, peg: null as number | null },
  { name: 'cbBTC', mint: new PublicKey('cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij'), decimals: 8, price: F_BTC, peg: F_CBBTC as number | null },
  { name: 'WBTC', mint: new PublicKey('3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh'), decimals: 8, price: F_BTC, peg: F_WBTC as number | null },
];
const priceFeed = (asset: number) => FEEDS[ASSETS[asset].price];
const pegFeed = (asset: number) => FEEDS[ASSETS[asset].peg ?? ASSETS[asset].price];
const POOLS = [
  { address: new PublicKey('HxA6SKW5qA4o12fjVgTpXdq2YnZ5Zv1s7SB4FFomsyLM'), a: 1, b: 0, vaultA: new PublicKey('FWiLr7QtETCRs3CxFTAMmLynitX8uEjw9HxpFjxKQrAe'), vaultB: new PublicKey('5ahiXjuZgWQPqYEay5GFHv5r3ycXqgxacoeXX7VetByd'), spacing: 4 },
  { address: new PublicKey('4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72'), a: 1, b: 2, vaultA: new PublicKey('Br2L7L6Vfro799PuNH7xdQPs6bZ4DGi2DMFsUX3DdUPW'), vaultB: new PublicKey('4WBthDFFdS8mqJ3o9hoxtaEewcn7nuXpqUnQiHhJfHVQ'), spacing: 1 },
];
const MIN_SQRT = 4295048016n, MAX_SQRT = 79226673515401279992447579055n, Q64 = 1n << 64n;
const orcaOracle = (pool: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('oracle'), pool.toBuffer()], ORCA)[0];
const tickArray = (pool: PublicKey, start: number) => PublicKey.findProgramAddressSync([Buffer.from('tick_array'), pool.toBuffer(), Buffer.from(String(start))], ORCA)[0];
const positionPda = (mint: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('position'), mint.toBuffer()], ORCA)[0];
const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, SAFE)[0];
const ata = (owner: PublicKey, mint: PublicKey, program = TOKEN_PROGRAM_ID) => getAssociatedTokenAddressSync(mint, owner, true, program);

// ------------------------------------------------------------------ LiteSVM setup
if (process.platform !== 'linux') throw Error('Run on Linux (LiteSVM)');
const svm = new runtime.LiteSVM().withTransactionHistory(BigInt(0));
svm.addProgramFromFile(SAFE.toBase58(), safeSo);
for (const p of snapshot.programs) svm.addProgramFromFile(p.programId, dir + '/' + p.name + '.so');
svm.addProgramFromFile(PROBE.toBase58(), probeSo);
type Acc = { lamports: number | bigint; owner: PublicKey; executable?: boolean; data: Buffer };
const setAccount = (key: PublicKey, a: Acc) => svm.setAccount({ address: key.toBase58(), lamports: BigInt(a.lamports), programAddress: a.owner.toBase58(), executable: !!a.executable, data: a.data, space: BigInt(a.data.length) });
const getAccount = (key: PublicKey) => { const a = svm.getAccount(key.toBase58()); return a.exists ? { lamports: BigInt(a.lamports), owner: new PublicKey(a.programAddress), data: Buffer.from(a.data) } : null; };
for (const a of snapshot.accounts) if (a.address !== 'SysvarC1ock11111111111111111111111111111111')
  setAccount(new PublicKey(a.address), { lamports: a.lamports, owner: new PublicKey(a.owner), executable: a.executable, data: Buffer.from(a.data, 'base64') });
const clockSnap = Buffer.from(snapshot.accounts.find((a: any) => a.address === 'SysvarC1ock11111111111111111111111111111111').data, 'base64');
const slot0 = clockSnap.readBigUInt64LE(0) + 10n, epoch0 = clockSnap.readBigUInt64LE(16);
let now = Number(clockSnap.readBigInt64LE(32));
const FEED_PRICE = 73, FEED_CONF = 81, FEED_TIME = 93, FEED_PREV = 101;
const originalFeeds = FEEDS.map((f) => getAccount(f)!.data);
function patchFeed(feed: number, change: { price?: bigint; conf?: bigint; age?: number }) {
  const d = Buffer.from(getAccount(FEEDS[feed])!.data);
  if (change.price !== undefined) d.writeBigInt64LE(change.price, FEED_PRICE);
  if (change.conf !== undefined) d.writeBigUInt64LE(change.conf, FEED_CONF);
  const t = BigInt(now - (change.age ?? 3));
  d.writeBigInt64LE(t, FEED_TIME); d.writeBigInt64LE(t - 1n, FEED_PREV);
  setAccount(FEEDS[feed], { lamports: 10_000_000, owner: new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ'), data: d });
}
function setNow(t: number) {
  now = t;
  svm.setClock(new runtime.Clock(slot0 + BigInt(t - Number(clockSnap.readBigInt64LE(32))), BigInt(t - 3600), epoch0, epoch0 + 1n, BigInt(t)));
  FEEDS.forEach((f, i) => { setAccount(f, { lamports: 10_000_000, owner: new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ'), data: originalFeeds[i] }); patchFeed(i, {}); });
}
setNow(now);
const rawFeed = (feed: number) => { const d = getAccount(FEEDS[feed])!.data; return { price: d.readBigInt64LE(FEED_PRICE), expo: d.readInt32LE(89) }; };
const feedPrice = (asset: number) => rawFeed(ASSETS[asset].price);

const [payer, owner, agent, attacker, trader, treasury] = Array.from({ length: 6 }, () => Keypair.generate());
for (const k of [payer, owner, agent, attacker, trader]) setAccount(k.publicKey, { lamports: 100_000_000_000, owner: SystemProgram.programId, data: Buffer.alloc(0) });
const idl = JSON.parse(readFileSync(idlPath, 'utf8')) as Idl;
const coder = new BorshAccountsCoder(idl);
const program = new Program(idl, new AnchorProvider(new Connection('http://127.0.0.1:1'), new Wallet(owner), {}));
const m = program.methods as any;
const fetch = async (name: string, key: PublicKey) => coder.decode(name, getAccount(key)!.data);

// ------------------------------------------------------------------ helpers
const report: any = {
  runtime: 'LiteSVM 1.5.0', snapshot: { slot: snapshot.slot, fetchedAt: snapshot.fetchedAt },
  safeElf: { path: safeSo, bytes: readFileSync(safeSo).length, sha256: createHash('sha256').update(readFileSync(safeSo)).digest('hex') },
  programs: snapshot.programs, steps: [], rejected: [],
};
const cuOf = (r: any) => Number(r.computeUnitsConsumed());
function build(ixs: TransactionInstruction[], signers: Keypair[]) {
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: signers[0].publicKey, recentBlockhash: svm.latestBlockhash(),
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs],
  }).compileToV0Message());
  tx.sign(signers);
  return tx;
}
function run(ixs: TransactionInstruction[], signers: Keypair[]) {
  const tx = build(ixs, signers), bytes = tx.serialize().length;
  const r = svm.sendTransaction(kit.getTransactionDecoder().decode(tx.serialize()));
  svm.expireBlockhash();
  const failed = r instanceof runtime.FailedTransactionMetadata, meta = failed ? r.meta() : r;
  return { ok: !failed, logs: meta.logs() as string[], cu: cuOf(meta), bytes, err: failed ? r.toString() : null };
}
function ok(label: string, ixs: TransactionInstruction[], signers: Keypair[], extra: Record<string, unknown> = {}) {
  const r = run(ixs, signers);
  if (!r.ok) { console.log(r.logs.join('\n')); throw Error(label + ': ' + r.err); }
  report.steps.push({ label, cu: r.cu, txBytes: r.bytes, ...extra });
  console.log('OK    ', label.padEnd(58), 'CU', r.cu, 'bytes', r.bytes);
  return r;
}
function rejects(label: string, ixs: TransactionInstruction[], signers: Keypair[], pattern: RegExp, watch: PublicKey[] = []) {
  const before = watch.map((k) => getAccount(k)?.data.toString('hex'));
  const r = run(ixs, signers), logs = r.logs.join('\n');
  assert(!r.ok, label + ' must fail');
  assert.match(logs + (r.err ?? ''), pattern, label + ': ' + logs.split('\n').slice(-4).join(' | '));
  watch.forEach((k, i) => assert.equal(getAccount(k)?.data.toString('hex'), before[i], label + ': state changed'));
  report.rejected.push({ label, error: (logs.match(/Error Code: (\w+)/) ?? [, pattern.source])[1] });
  console.log('REJECT', label.padEnd(58), (logs.match(/Error Code: (\w+)/) ?? [, pattern.source])[1]);
}
const amount = (key: PublicKey) => { const a = getAccount(key); return a ? a.data.readBigUInt64LE(64) : 0n; };
function tokenFixture(address: PublicKey, mint: PublicKey, holder: PublicKey, value: bigint) {
  const d = Buffer.alloc(165);
  AccountLayout.encode({ mint, owner: holder, amount: value, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, d);
  setAccount(address, { lamports: 2_039_280, owner: TOKEN_PROGRAM_ID, data: d });
}
const poolState = (i: number) => { const d = getAccount(POOLS[i].address)!.data; return { sqrt: d.readBigUInt64LE(65) + (d.readBigUInt64LE(73) << 64n), tick: d.readInt32LE(81), data: d }; };
function setPoolSqrt(i: number, sqrt: bigint) {
  const d = Buffer.from(getAccount(POOLS[i].address)!.data);
  d.writeBigUInt64LE(sqrt & ((1n << 64n) - 1n), 65); d.writeBigUInt64LE(sqrt >> 64n, 73);
  setAccount(POOLS[i].address, { lamports: getAccount(POOLS[i].address)!.lamports, owner: ORCA, data: d });
}
const restorePool = (i: number, data: Buffer) => setAccount(POOLS[i].address, { lamports: getAccount(POOLS[i].address)!.lamports, owner: ORCA, data });
const span = (i: number) => 88 * POOLS[i].spacing;
const startOf = (i: number, tick: number) => Math.floor(tick / span(i)) * span(i);
function swapTickArrays(i: number, aToB: boolean) {
  const { tick } = poolState(i), s = startOf(i, aToB ? tick : tick + POOLS[i].spacing), d = aToB ? -span(i) : span(i);
  return [0, 1, 2].map((k) => tickArray(POOLS[i].address, s + k * d));
}
// Oracle conversion with the same integer steps as orca.rs `convert`.
function oracleOut(amountIn: bigint, from: number, to: number) {
  const f = feedPrice(from), t = feedPrice(to);
  const net = (f.expo + ASSETS[to].decimals) - (t.expo + ASSETS[from].decimals);
  const num = amountIn * f.price;
  return net >= 0 ? num * 10n ** BigInt(net) / t.price : num / (t.price * 10n ** BigInt(-net));
}
const floorBps = (v: bigint, bps: number) => v * BigInt(10_000 - bps) / 10_000n;

// ------------------------------------------------------------------ program accounts
const config = pda(Buffer.from('config')), registry = pda(Buffer.from('executor_registry'));
const lpFeeConfig = pda(Buffer.from('lp_fee_config'));
const vault = pda(Buffer.from('vault'), owner.publicKey.toBuffer());
const limits = pda(Buffer.from('executor_limits'), vault.toBuffer());
const orcaPolicy = pda(Buffer.from('orca_policy'), vault.toBuffer());
const cpiPolicy = pda(Buffer.from('cpi_policy'), vault.toBuffer());
const recordOf = (mint: PublicKey) => pda(Buffer.from('orca_position'), vault.toBuffer(), mint.toBuffer());
const safeAta = ASSETS.map((a) => ata(vault, a.mint));
const ownerAta = ASSETS.map((a) => ata(owner.publicKey, a.mint));
const traderAta = ASSETS.map((a) => ata(trader.publicKey, a.mint));
const treasuryAta = ASSETS.map((a) => ata(treasury.publicKey, a.mint));
const attackerUsdc = ata(attacker.publicKey, ASSETS[0].mint);

async function fixture(name: string, address: PublicKey, data: Record<string, unknown>) {
  setAccount(address, { lamports: 1_000_000_000, owner: SAFE, data: await coder.encode(name, data) });
}

// ------------------------------------------------------------------ instruction builders
const swapIx = (pool: number, aToB: boolean, amountIn: bigint, minOut: bigint, signer: Keypair, over: Record<string, PublicKey> = {}) => {
  const p = POOLS[pool], [t0, t1, t2] = swapTickArrays(pool, aToB);
  return m.orcaSwap(pool, aToB, new BN(amountIn.toString()), new BN(minOut.toString())).accountsStrict({
    authority: signer.publicKey, vault, executorRegistry: registry, executorLimits: limits, orcaPolicy,
    whirlpool: p.address, safeTokenA: safeAta[p.a], safeTokenB: safeAta[p.b], tokenVaultA: p.vaultA, tokenVaultB: p.vaultB,
    tickArray0: t0, tickArray1: t1, tickArray2: t2, orcaOracle: orcaOracle(p.address),
    feedA: priceFeed(p.a), feedB: priceFeed(p.b), feedUsdc: FEEDS[F_USDC], pegA: pegFeed(p.a), pegB: pegFeed(p.b), tokenProgram: TOKEN_PROGRAM_ID, orcaProgram: ORCA, ...over,
  }).instruction();
};
const openIx = (pool: number, lower: number, upper: number, signer: Keypair, mint: Keypair) => m.orcaLpOpen(pool, lower, upper).accountsStrict({
  authority: signer.publicKey, vault, executorRegistry: registry, orcaPolicy, lpFeeConfig, whirlpool: POOLS[pool].address,
  position: positionPda(mint.publicKey), positionMint: mint.publicKey, positionTokenAccount: ata(vault, mint.publicKey, TOKEN_2022_PROGRAM_ID),
  positionRecord: recordOf(mint.publicKey), feedA: priceFeed(POOLS[pool].a), feedB: priceFeed(POOLS[pool].b), feedUsdc: FEEDS[F_USDC],
  pegA: pegFeed(POOLS[pool].a), pegB: pegFeed(POOLS[pool].b),
  token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  metadataUpdateAuth: META_AUTH, orcaProgram: ORCA,
}).instruction();
type Pos = { mint: Keypair; pool: number; lower: number; upper: number };
const liquidityAccounts = (pos: Pos, signer: Keypair) => {
  const p = POOLS[pos.pool];
  return {
    authority: signer.publicKey, vault, executorRegistry: registry, executorLimits: limits, orcaPolicy, positionRecord: recordOf(pos.mint.publicKey),
    whirlpool: p.address, position: positionPda(pos.mint.publicKey), positionTokenAccount: ata(vault, pos.mint.publicKey, TOKEN_2022_PROGRAM_ID),
    tokenMintA: ASSETS[p.a].mint, tokenMintB: ASSETS[p.b].mint, safeTokenA: safeAta[p.a], safeTokenB: safeAta[p.b],
    tokenVaultA: p.vaultA, tokenVaultB: p.vaultB, tickArrayLower: tickArray(p.address, startOf(pos.pool, pos.lower)),
    tickArrayUpper: tickArray(p.address, startOf(pos.pool, pos.upper)), feedA: priceFeed(p.a), feedB: priceFeed(p.b),
    feedUsdc: FEEDS[F_USDC], pegA: pegFeed(p.a), pegB: pegFeed(p.b), tokenProgram: TOKEN_PROGRAM_ID, memoProgram: MEMO, orcaProgram: ORCA,
  };
};
const increaseIx = (pos: Pos, liq: bigint, maxA: bigint, maxB: bigint, signer: Keypair) =>
  m.orcaLpIncrease(new BN(liq.toString()), new BN(maxA.toString()), new BN(maxB.toString())).accountsStrict(liquidityAccounts(pos, signer)).instruction();
const decreaseIx = (pos: Pos, liq: bigint, signer: Keypair) =>
  m.orcaLpDecrease(new BN(liq.toString()), new BN(0), new BN(0)).accountsStrict(liquidityAccounts(pos, signer)).instruction();
const collectIx = (pos: Pos, signer: Keypair) => {
  const p = POOLS[pos.pool], l = liquidityAccounts(pos, signer);
  return m.orcaLpCollect().accountsStrict({
    authority: signer.publicKey, vault, executorRegistry: registry, orcaPolicy, config, positionRecord: l.positionRecord,
    whirlpool: p.address, position: l.position, positionTokenAccount: l.positionTokenAccount, tickArrayLower: l.tickArrayLower,
    tickArrayUpper: l.tickArrayUpper, tokenMintA: l.tokenMintA, tokenMintB: l.tokenMintB, safeTokenA: l.safeTokenA, safeTokenB: l.safeTokenB,
    tokenVaultA: p.vaultA, tokenVaultB: p.vaultB, treasuryTokenA: treasuryAta[p.a], treasuryTokenB: treasuryAta[p.b],
    tokenProgram: TOKEN_PROGRAM_ID, memoProgram: MEMO, orcaProgram: ORCA,
  }).instruction();
};
const closeIx = (pos: Pos, signer: Keypair, receiver: PublicKey) => m.orcaLpClose().accountsStrict({
  authority: signer.publicKey, vault, executorRegistry: registry, orcaPolicy, positionRecord: recordOf(pos.mint.publicKey), receiver,
  position: positionPda(pos.mint.publicKey), positionMint: pos.mint.publicKey, positionTokenAccount: ata(vault, pos.mint.publicKey, TOKEN_2022_PROGRAM_ID),
  token2022Program: TOKEN_2022_PROGRAM_ID, orcaProgram: ORCA,
}).instruction();
const exitIx = (pos: Pos, receiver: PublicKey) => {
  const l = liquidityAccounts(pos, owner);
  return m.orcaLpExitNft().accountsStrict({
    owner: owner.publicKey, vault, orcaPolicy, positionRecord: recordOf(pos.mint.publicKey), receiver, whirlpool: POOLS[pos.pool].address,
    position: l.position, tickArrayLower: l.tickArrayLower, tickArrayUpper: l.tickArrayUpper, positionMint: pos.mint.publicKey,
    safePositionAta: l.positionTokenAccount, ownerPositionAta: ata(owner.publicKey, pos.mint.publicKey, TOKEN_2022_PROGRAM_ID),
    token2022Program: TOKEN_2022_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, orcaProgram: ORCA,
  }).instruction();
};
const policyIx = (args: Record<string, unknown>) => m.setOrcaPolicy(args).accountsStrict({ owner: owner.publicKey, vault, orcaPolicy, systemProgram: SystemProgram.programId }).instruction();
const genericIx = (data: Buffer, keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]) =>
  m.executeProtocolCpi(data).accountsStrict({ authority: owner.publicKey, vault }).remainingAccounts(keys).instruction();

// Trader swaps straight on Orca (outside the Safe) to move price and accrue LP fees.
function traderSwap(pool: number, aToB: boolean, amountIn: bigint) {
  const p = POOLS[pool], [t0, t1, t2] = swapTickArrays(pool, aToB);
  const data = Buffer.concat([Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]), u64(amountIn), u64(0n), u128(aToB ? MIN_SQRT : MAX_SQRT), Buffer.from([1, aToB ? 1 : 0])]);
  const w = (k: PublicKey) => ({ pubkey: k, isSigner: false, isWritable: true });
  return new TransactionInstruction({ programId: ORCA, data, keys: [
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: trader.publicKey, isSigner: true, isWritable: false },
    w(p.address), w(traderAta[p.a]), w(p.vaultA), w(traderAta[p.b]), w(p.vaultB), w(t0), w(t1), w(t2), w(orcaOracle(p.address)),
  ] });
}
function u64(v: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; }
function u128(v: bigint) { return Buffer.concat([u64(v & ((1n << 64n) - 1n)), u64(v >> 64n)]); }

// Orca tick -> sqrt price (Q64.64), same as Orca's PriceMath for the ranges used here.
function tickToSqrt(tick: number) { return BigInt(Math.round(Math.sqrt(1.0001 ** tick) * 2 ** 32)) * (1n << 32n); }
function liquidityFor(pool: number, lower: number, upper: number, budgetA: bigint, budgetB: bigint) {
  const sp = poolState(pool).sqrt, sa = tickToSqrt(lower), sb = tickToSqrt(upper);
  const lB = budgetB * Q64 / (sp - sa), lA = budgetA * ((sp * sb) / Q64) / (sb - sp);
  return (lA < lB ? lA : lB) * 95n / 100n;
}
const readPosition = (mint: PublicKey) => { const d = getAccount(positionPda(mint))!.data; return { liquidity: d.readBigUInt64LE(72) + (d.readBigUInt64LE(80) << 64n), feeA: d.readBigUInt64LE(112), feeB: d.readBigUInt64LE(136) }; };
function range(pool: number, half: number) {
  const { tick } = poolState(pool), s = POOLS[pool].spacing;
  return { lower: Math.floor((tick - half) / s) * s, upper: Math.ceil((tick + half) / s) * s };
}
const basePolicy = {
  agentEnabled: true, poolsMask: 0b11, maxSlippageBps: 50, maxOracleDeviationBps: 50,
  maxHoldUsdc: [new BN(0), new BN(60_000_000_000), new BN(60_000_000_000)], maxLpPrincipalUsdc: new BN(50_000_000_000),
  minWidthTicks: 40, maxWidthTicks: 4_000, maxOpens24H: 3,
};

// ================================================================== scenario
try {
  // ---------------------------------------------------------------- setup
  await fixture('Config', config, { admin: payer.publicKey, treasury: treasury.publicKey, performanceFeeBps: 500, bump: PublicKey.findProgramAddressSync([Buffer.from('config')], SAFE)[1] });
  await fixture('ExecutorRegistry', registry, { bump: PublicKey.findProgramAddressSync([Buffer.from('executor_registry')], SAFE)[1], defaultExecutor: agent.publicKey, approved: [agent.publicKey] });
  tokenFixture(ownerAta[0], ASSETS[0].mint, owner.publicKey, 1_000_000_000_000n);
  tokenFixture(traderAta[0], ASSETS[0].mint, trader.publicKey, 50_000_000_000_000n);
  tokenFixture(traderAta[1], ASSETS[1].mint, trader.publicKey, 500_00000000n);
  tokenFixture(traderAta[2], ASSETS[2].mint, trader.publicKey, 500_00000000n);
  tokenFixture(attackerUsdc, ASSETS[0].mint, attacker.publicKey, 0n);
  ok('initialize_with_limits (ORCA_LP allocation 50%)', [await m.initializeWithLimits(agent.publicKey, [0, 0, 5000, 0, 0, 0, 0, 0], []).accountsStrict({
    owner: owner.publicKey, vault, executorRegistry: registry, usdcMint: ASSETS[0].mint, vaultUsdcAta: safeAta[0], tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, executorLimits: limits }).instruction()], [owner]);
  ok('deposit 200,000 USDC', [await m.deposit(new BN(200_000_000_000)).accountsStrict({ owner: owner.publicKey, vault, usdcMint: ASSETS[0].mint,
    ownerUsdcAta: ownerAta[0], vaultUsdcAta: safeAta[0], tokenProgram: TOKEN_PROGRAM_ID }).instruction()], [owner]);
  ok('create Safe and treasury ATAs', [1, 2].flatMap((i) => [
    createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, safeAta[i], vault, ASSETS[i].mint),
  ]).concat([0, 1, 2].map((i) => createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, treasuryAta[i], treasury.publicKey, ASSETS[i].mint))), [owner]);
  ok('set_executor_limits 50k / 200k / 100k', [await m.setExecutorLimits(new BN(50_000_000_000), new BN(200_000_000_000), new BN(100_000_000_000), true)
    .accountsStrict({ owner: owner.publicKey, vault, executorLimits: limits, systemProgram: SystemProgram.programId }).instruction()], [owner]);
  rejects('set_orca_policy slippage 301 bps', [await policyIx({ ...basePolicy, maxSlippageBps: 301 })], [owner], /InvalidPolicy/);
  ok('set_orca_policy', [await policyIx(basePolicy)], [owner]);
  rejects('init_lp_fee_config by non-admin', [await m.initLpFeeConfig().accountsStrict({ admin: attacker.publicKey, config, lpFeeConfig, systemProgram: SystemProgram.programId }).instruction()], [attacker], /ConstraintHasOne|has one/i);
  ok('init_lp_fee_config (admin)', [await m.initLpFeeConfig().accountsStrict({ admin: payer.publicKey, config, lpFeeConfig, systemProgram: SystemProgram.programId }).instruction()], [payer]);
  assert.equal((await fetch('LpFeeConfig', lpFeeConfig)).lp_fee_bps ?? (await fetch('LpFeeConfig', lpFeeConfig)).lpFeeBps, 1000);
  const setFee = (bps: number, signer = payer) => m.setLpFee(bps).accountsStrict({ admin: signer.publicKey, config, lpFeeConfig }).instruction();
  rejects('set_lp_fee 2001 bps', [await setFee(2001)], [payer], /FeeTooHigh/);

  // ---------------------------------------------------------------- swaps
  const usdcIn = 20_000_000_000n, expected = oracleOut(usdcIn, 0, 1), floor = floorBps(expected, 50);
  rejects('owner swap with min_out below the Pyth floor', [await swapIx(0, false, usdcIn, floor - 1n, owner)], [owner], /Slippage/, [safeAta[0], safeAta[1]]);
  const before = [amount(safeAta[0]), amount(safeAta[1])];
  ok('owner orca_swap 20,000 USDC -> cbBTC', [await swapIx(0, false, usdcIn, floor, owner)], [owner]);
  const got = amount(safeAta[1]) - before[1];
  assert.equal(before[0] - amount(safeAta[0]), usdcIn); assert(got >= floor);
  report.swapVsOracleBps = Number((expected - got) * 10_000n / expected);
  console.log('       received', got, 'cbBTC raw; oracle', expected, '; shortfall bps', report.swapVsOracleBps);
  ok('agent orca_swap 10,000 USDC -> cbBTC', [await swapIx(0, false, 10_000_000_000n, floorBps(oracleOut(10_000_000_000n, 0, 1), 50), agent)], [agent]);
  rejects('agent buys past max_hold_usdc for cbBTC', [await swapIx(0, false, 40_000_000_000n, floorBps(oracleOut(40_000_000_000n, 0, 1), 50), agent)], [agent], /HoldLimit/, [safeAta[0], safeAta[1]]);
  ok('policy: high cbBTC holding cap', [await policyIx({ ...basePolicy, maxHoldUsdc: [new BN(0), new BN(1_000_000_000_000), new BN(0)] })], [owner]);
  rejects('agent action above max_action_usdc (50,000 USDC)', [await swapIx(0, false, 50_000_000_001n, floorBps(oracleOut(50_000_000_001n, 0, 1), 50), agent)], [agent], /ExecutorActionLimit/, [safeAta[0], safeAta[1]]);
  ok('policy restored', [await policyIx(basePolicy)], [owner]);
  ok('agent orca_swap 0.05 cbBTC -> WBTC (pool 1)', [await swapIx(1, true, 5_000_000n, floorBps(oracleOut(5_000_000n, 1, 2), 50), agent)], [agent]);
  ok('policy: agent pools_mask = pool 0 only', [await policyIx({ ...basePolicy, poolsMask: 0b01 })], [owner]);
  rejects('agent swap on a pool outside pools_mask', [await swapIx(1, true, 1_000_000n, floorBps(oracleOut(1_000_000n, 1, 2), 50), agent)], [agent], /PoolDisabled/);
  ok('policy: agent disabled', [await policyIx({ ...basePolicy, agentEnabled: false })], [owner]);
  rejects('agent swap with agent_enabled = false', [await swapIx(0, false, 1_000_000n, 1n, agent)], [agent], /AgentDisabled/);
  ok('policy restored', [await policyIx(basePolicy)], [owner]);
  rejects('attacker as authority', [await swapIx(0, false, 1_000_000n, 1n, attacker)], [attacker], /Unauthorized/);
  patchFeed(F_BTC, { age: 91 });
  rejects('stale BTC/USD price feed (91 s)', [await swapIx(0, false, 1_000_000n, 1n, owner)], [owner], /StaleOracle/);
  patchFeed(F_BTC, { age: 90 });
  ok('BTC/USD price feed exactly 90 s old', [await swapIx(0, false, 1_000_000n, floorBps(oracleOut(1_000_000n, 0, 1), 50), owner)], [owner]);
  setNow(now);
  patchFeed(F_CBBTC, { age: 600 });
  ok('cbBTC peg feed 600 s old (measured cadence ~270 s)', [await swapIx(0, false, 1_000_000n, floorBps(oracleOut(1_000_000n, 0, 1), 50), owner)], [owner]);
  patchFeed(F_CBBTC, { age: 601 });
  rejects('cbBTC peg feed 601 s old', [await swapIx(0, false, 1_000_000n, 1n, owner)], [owner], /StaleOracle/);
  setNow(now);
  patchFeed(F_CBBTC, { price: rawFeed(F_BTC).price * 98n / 100n });
  rejects('cbBTC 2% below BTC/USD (depeg)', [await swapIx(0, false, 1_000_000n, 1n, owner)], [owner], /Depeg/);
  setNow(now);
  patchFeed(F_WBTC, { price: rawFeed(F_BTC).price * 103n / 100n });
  rejects('WBTC 3% above BTC/USD (depeg, pool 1)', [await swapIx(1, true, 1_000_000n, 1n, owner)], [owner], /Depeg/);
  setNow(now);
  patchFeed(F_BTC, { conf: rawFeed(F_BTC).price / 50n });
  rejects('BTC/USD confidence 2%', [await swapIx(0, false, 1_000_000n, 1n, owner)], [owner], /OracleConfidence/);
  setNow(now);
  rejects('cbBTC peg feed passed as the price feed', [await swapIx(0, false, 1_000_000n, 1n, owner, { feedA: FEEDS[F_CBBTC] })], [owner], /InvalidOracle/);
  rejects('BTC/USD passed as the cbBTC peg feed', [await swapIx(0, false, 1_000_000n, 1n, owner, { pegA: FEEDS[F_BTC] })], [owner], /InvalidOracle/);
  rejects('WBTC peg feed for USDC (no peg feed)', [await swapIx(0, false, 1_000_000n, 1n, owner, { pegB: FEEDS[F_WBTC] })], [owner], /InvalidOracle/);
  rejects('output into attacker USDC account', [await swapIx(0, true, 1_000n, 1n, owner, { safeTokenB: attackerUsdc })], [owner], /ConstraintTokenOwner|InvalidSafeAccount/);
  rejects('substituted pool vault', [await swapIx(0, false, 1_000_000n, 1n, owner, { tokenVaultA: POOLS[1].vaultA })], [owner], /InvalidPoolState/);
  rejects('pool index 0 with pool 1 account', [await swapIx(0, false, 1_000_000n, 1n, owner, { whirlpool: POOLS[1].address })], [owner], /UnknownPool/);
  rejects('tick array not owned by Orca', [await swapIx(0, false, 1_000_000n, 1n, owner, { tickArray1: ownerAta[0] })], [owner], /InvalidTickArray/);
  const pool0 = poolState(0);
  setPoolSqrt(0, pool0.sqrt * 1005n / 1000n); // ~1% price move
  rejects('pool price 1% away from Pyth', [await swapIx(0, false, 1_000_000n, 1n, owner)], [owner], /PriceOutOfBand/);
  restorePool(0, pool0.data);

  // ---------------------------------------------------------------- LP: agent position P1
  const p1: Pos = { mint: Keypair.generate(), pool: 0, ...range(0, 100) };
  rejects('agent open with width below min_width_ticks', [await openIx(0, range(0, 8).lower, range(0, 8).upper, agent, p1.mint)], [agent, p1.mint], /InvalidRange/);
  const agentLamports0 = getAccount(agent.publicKey)!.lamports;
  ok('agent orca_lp_open P1 (cbBTC/USDC, ~±1%)', [await openIx(0, p1.lower, p1.upper, agent, p1.mint)], [agent, p1.mint]);
  let rec = await fetch('OrcaPositionRecord', recordOf(p1.mint.publicKey));
  assert.equal(rec.fee_bps ?? rec.feeBps, 1000); assert((rec.funder as PublicKey).equals(agent.publicKey));
  const liq1 = liquidityFor(0, p1.lower, p1.upper, amount(safeAta[1]) / 2n, 15_000_000_000n);
  const s1 = [amount(safeAta[1]), amount(safeAta[0])];
  ok('agent orca_lp_increase P1', [await increaseIx(p1, liq1, amount(safeAta[1]), amount(safeAta[0]), agent)], [agent]);
  rec = await fetch('OrcaPositionRecord', recordOf(p1.mint.publicKey));
  const principal1 = BigInt((rec.principal_usdc ?? rec.principalUsdc).toString());
  const spentA = s1[0] - amount(safeAta[1]), spentB = s1[1] - amount(safeAta[0]);
  const value1 = oracleOut(spentA, 1, 0) + spentB;
  assert(principal1 > 0n && (principal1 - value1 <= 2n && value1 - principal1 <= 2n), `principal ${principal1} vs oracle value ${value1}`);
  const vaultAcc = await fetch('Vault', vault);
  assert.equal(BigInt((vaultAcc.route_principal ?? vaultAcc.routePrincipal)[2].toString()), principal1);
  console.log('       P1 liquidity', liq1, 'spent cbBTC', spentA, 'USDC', spentB, 'principal', principal1);
  const pool0b = poolState(0);
  setPoolSqrt(0, pool0b.sqrt * 1005n / 1000n);
  rejects('owner increase while pool is outside the band', [await increaseIx(p1, liq1 / 10n, amount(safeAta[1]), amount(safeAta[0]), owner)], [owner], /PriceOutOfBand/);
  restorePool(0, pool0b.data);
  ok('policy: max_lp_principal_usdc = principal + 1', [await policyIx({ ...basePolicy, maxLpPrincipalUsdc: new BN((principal1 + 1n).toString()) })], [owner]);
  rejects('agent increase past max_lp_principal_usdc', [await increaseIx(p1, liq1 / 10n, amount(safeAta[1]), amount(safeAta[0]), agent)], [agent], /ExecutorPositionLimit/);
  ok('policy restored', [await policyIx(basePolicy)], [owner]);

  // Trader volume through P1's range accrues fees; each leg returns most of the move.
  for (let k = 0; k < 4; k++) {
    const usdcBefore = amount(traderAta[1]);
    ok(`trader swap ${k + 1}a 300,000 USDC -> cbBTC`, [traderSwap(0, false, 300_000_000_000n)], [trader]);
    ok(`trader swap ${k + 1}b cbBTC back`, [traderSwap(0, true, amount(traderAta[1]) - usdcBefore)], [trader]);
  }
  ok('admin set_lp_fee 2000 after P1 opened', [await setFee(2000)], [payer]);
  const tb = [amount(treasuryAta[1]), amount(treasuryAta[0])], sb = [amount(safeAta[1]), amount(safeAta[0])];
  ok('agent orca_lp_collect P1', [await collectIx(p1, agent)], [agent]);
  const feeA = amount(treasuryAta[1]) - tb[0], feeB = amount(treasuryAta[0]) - tb[1];
  const collA = amount(safeAta[1]) - sb[0] + feeA, collB = amount(safeAta[0]) - sb[1] + feeB;
  assert(collA > 0n || collB > 0n, 'no LP fees accrued');
  assert.equal(feeA, collA * 1000n / 10_000n); assert.equal(feeB, collB * 1000n / 10_000n);
  report.lpFee = { collectedCbBtc: collA.toString(), collectedUsdc: collB.toString(), treasuryCbBtc: feeA.toString(), treasuryUsdc: feeB.toString(), bps: 1000 };
  console.log('       collected', collA, 'cbBTC raw,', collB, 'USDC raw; treasury', feeA, '/', feeB, '(10%, snapshotted)');
  const liqNow = readPosition(p1.mint.publicKey).liquidity;
  ok('agent orca_lp_decrease P1 50%', [await decreaseIx(p1, liqNow / 2n, agent)], [agent]);
  rec = await fetch('OrcaPositionRecord', recordOf(p1.mint.publicKey));
  const half = BigInt((rec.principal_usdc ?? rec.principalUsdc).toString());
  assert(half === principal1 - principal1 * (liqNow / 2n) / liqNow);
  {
    const c = amount(traderAta[1]);
    ok('trader round trip (fees owed on the remaining half)', [traderSwap(0, false, 300_000_000_000n)], [trader]);
    ok('trader round trip back', [traderSwap(0, true, amount(traderAta[1]) - c)], [trader]);
  }
  patchFeed(F_BTC, { age: 1_000 });
  rejects('agent decrease with a stale oracle', [await decreaseIx(p1, readPosition(p1.mint.publicKey).liquidity, agent)], [agent], /StaleOracle/);
  ok('owner orca_lp_decrease P1 rest with a stale oracle (exit path)', [await decreaseIx(p1, readPosition(p1.mint.publicKey).liquidity, owner)], [owner]);
  setNow(now);
  assert.equal(BigInt(((await fetch('Vault', vault)).route_principal ?? (await fetch('Vault', vault)).routePrincipal)[2].toString()), 0n);
  rejects('close with uncollected fees', [await closeIx(p1, agent, agent.publicKey)], [agent], /NotEmpty|0x1774|ClosePositionNotEmpty|custom program error/i);
  ok('agent orca_lp_collect P1 (after exit)', [await collectIx(p1, agent)], [agent]);
  rejects('close sending rent to someone else', [await closeIx(p1, agent, attacker.publicKey)], [agent], /InvalidReceiver/);
  ok('agent orca_lp_close P1', [await closeIx(p1, agent, agent.publicKey)], [agent]);
  assert.equal(getAccount(recordOf(p1.mint.publicKey)), null); assert.equal(getAccount(positionPda(p1.mint.publicKey)), null);
  report.positionRentNetLamports = (getAccount(agent.publicKey)!.lamports - agentLamports0).toString();

  // ---------------------------------------------------------------- fee snapshot, NFT guards, owner exit
  const p2: Pos = { mint: Keypair.generate(), pool: 0, ...range(0, 100) };
  ok('agent orca_lp_open P2 after set_lp_fee 2000', [await openIx(0, p2.lower, p2.upper, agent, p2.mint)], [agent, p2.mint]);
  rec = await fetch('OrcaPositionRecord', recordOf(p2.mint.publicKey));
  assert.equal(rec.fee_bps ?? rec.feeBps, 2000);
  const nft2 = ata(vault, p2.mint.publicKey, TOKEN_2022_PROGRAM_ID);
  rejects('withdraw_spl of a position NFT', [await m.withdrawSpl(new BN(1)).accountsStrict({ owner: owner.publicKey, vault, mint: p2.mint.publicKey,
    ownerTokenAta: ata(owner.publicKey, p2.mint.publicKey, TOKEN_2022_PROGRAM_ID), vaultTokenAta: nft2, tokenProgram: TOKEN_2022_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).instruction()], [owner], /UseDedicatedInstruction/);
  const p3: Pos = { mint: Keypair.generate(), pool: 0, ...range(0, 200) };
  ok('owner orca_lp_open P3', [await openIx(0, p3.lower, p3.upper, owner, p3.mint)], [owner, p3.mint]);
  ok('owner orca_lp_increase P3', [await increaseIx(p3, liquidityFor(0, p3.lower, p3.upper, amount(safeAta[1]) / 2n, 5_000_000_000n), amount(safeAta[1]), amount(safeAta[0]), owner)], [owner]);
  for (let k = 0; k < 2; k++) {
    const c = amount(traderAta[1]);
    ok(`trader swap round ${k + 1} (fees for P3)`, [traderSwap(0, false, 300_000_000_000n)], [trader]);
    ok(`trader swap round ${k + 1} back`, [traderSwap(0, true, amount(traderAta[1]) - c)], [trader]);
  }
  rejects('orca_lp_exit_nft with uncollected fees', [await exitIx(p3, owner.publicKey)], [owner], /CollectFirst/);
  ok('owner orca_lp_collect P3', [await collectIx(p3, owner)], [owner]);
  const routeBeforeExit = BigInt(((await fetch('Vault', vault)).route_principal ?? (await fetch('Vault', vault)).routePrincipal)[2].toString());
  ok('owner orca_lp_exit_nft P3 (liquidity stays in the NFT)', [await exitIx(p3, owner.publicKey)], [owner]);
  assert.equal(amount(ata(owner.publicKey, p3.mint.publicKey, TOKEN_2022_PROGRAM_ID)), 1n);
  assert.equal(getAccount(recordOf(p3.mint.publicKey)), null);
  const routeAfterExit = BigInt(((await fetch('Vault', vault)).route_principal ?? (await fetch('Vault', vault)).routePrincipal)[2].toString());
  assert(routeAfterExit < routeBeforeExit || routeBeforeExit === 0n);
  rejects('deposit_spl of a position NFT back into the Safe', [await m.depositSpl(new BN(1)).accountsStrict({ owner: owner.publicKey, vault, mint: p3.mint.publicKey,
    ownerTokenAta: ata(owner.publicKey, p3.mint.publicKey, TOKEN_2022_PROGRAM_ID), vaultTokenAta: ata(vault, p3.mint.publicKey, TOKEN_2022_PROGRAM_ID),
    tokenProgram: TOKEN_2022_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).instruction()], [owner], /UseDedicatedInstruction/);

  // ---------------------------------------------------------------- open counters
  const p4: Pos = { mint: Keypair.generate(), pool: 0, ...range(0, 100) };
  ok('agent orca_lp_open P4 (3rd agent open today)', [await openIx(0, p4.lower, p4.upper, agent, p4.mint)], [agent, p4.mint]);
  const p5 = Keypair.generate();
  rejects('agent 4th open within 24 h', [await openIx(0, p4.lower, p4.upper, agent, p5)], [agent, p5], /RebalanceLimit/);
  const p6 = Keypair.generate(), p7 = Keypair.generate();
  ok('owner open P6', [await openIx(0, p4.lower, p4.upper, owner, p6)], [owner, p6]);
  ok('owner open P7 (4 positions registered)', [await openIx(0, p4.lower, p4.upper, owner, p7)], [owner, p7]);
  setNow(now + 86_400);
  rejects('5th registered position', [await openIx(0, p4.lower, p4.upper, agent, p5)], [agent, p5], /TooManyPositions/);

  // ---------------------------------------------------------------- generic CPI policy
  const propose = (signer: Keypair, target: PublicKey) => m.proposeAllowedProgram(target).accountsStrict({ owner: signer.publicKey, vault, cpiPolicy, systemProgram: SystemProgram.programId }).instruction();
  const pending = (name: 'activateAllowedProgram' | 'cancelAllowedProgram', target: PublicKey) => m[name](target).accountsStrict({ owner: owner.publicKey, vault, cpiPolicy }).instruction();
  rejects('propose SPL Token', [await propose(owner, TOKEN_PROGRAM_ID)], [owner], /ProgramDenied/);
  rejects('propose Orca (typed route)', [await propose(owner, ORCA)], [owner], /UseDedicatedInstruction/);
  rejects('set_allowed_programs addition', [await m.setAllowedPrograms([PROBE]).accountsStrict({ owner: owner.publicKey, vault, systemProgram: SystemProgram.programId }).instruction()], [owner], /UseTimelock/);
  ok('propose cpi-probe', [await propose(owner, PROBE)], [owner]);
  rejects('activate before 48 h', [await pending('activateAllowedProgram', PROBE)], [owner], /TimelockActive/);
  setNow(now + 48 * 3600 - 1);
  rejects('activate 1 s before 48 h', [await pending('activateAllowedProgram', PROBE)], [owner], /TimelockActive/);
  setNow(now + 1);
  ok('activate cpi-probe after 48 h', [await pending('activateAllowedProgram', PROBE)], [owner]);
  const probeKeys = (target: PublicKey, other: PublicKey, extra: PublicKey[] = []) => [
    { pubkey: PROBE, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: target, isSigner: false, isWritable: true }, { pubkey: other, isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: false }, ...extra.map((k) => ({ pubkey: k, isSigner: false, isWritable: false })),
  ];
  rejects('probe Approve on Safe USDC (delegate attacker)', [await genericIx(Buffer.from([0, ...u64(1_000_000n)]), probeKeys(safeAta[0], attacker.publicKey))], [owner], /SafeAccountChanged/, [safeAta[0]]);
  rejects('probe SetAuthority on Safe USDC ATA', [await genericIx(Buffer.from([1]), probeKeys(safeAta[0], attacker.publicKey))], [owner], /SafeAccountChanged/, [safeAta[0]]);
  rejects('probe with a Safe Token-2022 account', [await genericIx(Buffer.from([2, ...u64(1n)]), probeKeys(nft2, attacker.publicKey))], [owner], /Token2022NotAllowed/);
  rejects('probe with Orca in the account list', [await genericIx(Buffer.from([2, ...u64(1n)]), probeKeys(safeAta[0], attackerUsdc, [ORCA]))], [owner], /UseDedicatedInstruction/);
  const residual0 = amount(attackerUsdc);
  ok('RESIDUAL: activated probe moves 1 USDC to attacker', [await genericIx(Buffer.from([2, ...u64(1_000_000n)]), probeKeys(safeAta[0], attackerUsdc))], [owner]);
  assert.equal(amount(attackerUsdc) - residual0, 1_000_000n);
  report.residualRisk = 'An activated allowlisted program can still transfer Safe tokens to any account; only the 48 h timelock and UI review protect against that.';
  ok('set_allowed_programs([]) removes immediately', [await m.setAllowedPrograms([]).accountsStrict({ owner: owner.publicKey, vault, systemProgram: SystemProgram.programId }).instruction()], [owner]);
  rejects('probe after removal', [await genericIx(Buffer.from([2, ...u64(1n)]), probeKeys(safeAta[0], attackerUsdc))], [owner], /ProgramNotWhitelisted/);

  // ---------------------------------------------------------------- lifecycle guards
  setNow(now);
  ok('owner orca_lp_increase P2 (open principal)', [await increaseIx(p2, liquidityFor(0, p2.lower, p2.upper, amount(safeAta[1]) / 4n, 1_000_000_000n), amount(safeAta[1]), amount(safeAta[0]), owner)], [owner]);
  rejects('close_safe with open route principal', [await m.closeSafe().accountsStrict({ owner: owner.publicKey, vault }).remainingAccounts([{ pubkey: limits, isSigner: false, isWritable: true }]).instruction()], [owner], /OpenRoutePrincipal/, [vault]);
  {
    // Size and CU of a combined open + increase: does one transaction fit without a lookup table?
    const p8: Pos = { mint: Keypair.generate(), pool: 0, ...range(0, 100) };
    const ixs = [await openIx(0, p8.lower, p8.upper, owner, p8.mint), await increaseIx(p8, 1_000_000n, amount(safeAta[1]), amount(safeAta[0]), owner)];
    let bytes = 0;
    try { bytes = build(ixs, [owner, p8.mint]).serialize().length; } catch (e) { bytes = -1; }
    report.openPlusIncreaseBytesWithoutAlt = bytes;
    console.log('       open + increase in one v0 tx without ALT:', bytes < 0 ? 'over 1232 bytes' : bytes + ' bytes');
  }
  rejects('refund_excess_lamports by agent', [await m.refundExcessLamports(new BN(1), new BN(0)).accountsStrict({ authority: agent.publicKey, vault }).instruction()], [agent], /Unauthorized/);
  report.ok = true;
} finally {
  writeFileSync(dir + '/orca-fork-report.json', JSON.stringify(report, null, 2));
  console.log(`\n${report.steps.length} successful steps, ${report.rejected.length} expected rejections. Report: ${dir}/orca-fork-report.json`);
}
