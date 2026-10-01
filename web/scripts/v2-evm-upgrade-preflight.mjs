/** Read-only Devnet upgrade preflight. No wallet files, signing or send RPC methods. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PublicKey, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import { BorshAccountsCoder } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount, unpackMint } from "@solana/spl-token";

const program = new PublicKey("8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5");
const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const authority = new PublicKey("8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A");
const mint = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const owner = "0x70d5d723Ba7f39Cfb676C67Bbd4b5D6aE8047f4B";
const ownerBytes = Buffer.from(owner.slice(2), "hex");
const [safe] = PublicKey.findProgramAddressSync([Buffer.from("vault_evm"), ownerBytes], program);
const ata = getAssociatedTokenAddressSync(mint, safe, true);
const [programData] = PublicKey.findProgramAddressSync([program.toBuffer()], loader);
const lifecycle = process.argv[2] === "--lifecycle";
const binary = readFileSync(new URL(lifecycle ? "../../target/deploy/yield_vault.so" : "../../target/deploy/yield_vault-devnet-withdraw-20261001.so", import.meta.url));
const sha256 = data => createHash("sha256").update(data).digest("hex");
const expectedNewHash = lifecycle ? "4a2a277a6df06bbcafe172f90ff88bfc3d31fe34b4309b2b6913a4d7b70fdf98" : "fee494161131cc44fb572f3bcbf5b019170b4414a41221b614f6337b5aaa7489";
const expectedOldHash = lifecycle ? "fee494161131cc44fb572f3bcbf5b019170b4414a41221b614f6337b5aaa7489" : "ec3a33f0534caa36dea969eb140e5d881fca9ad55fee94f68535745737d33bb2";
assert.equal(binary.length, lifecycle ? 695488 : 688864, "reviewed binary size changed");
assert.equal(sha256(binary), expectedNewHash, "reviewed binary hash changed");
const url = process.env.V2_DEVNET_RPC_URL || "https://api.devnet.solana.com";
assert.equal(new URL(url).protocol, "https:", "public preflight requires HTTPS");
let rpcId = 0;
async function rpc(method, params = []) {
  assert(["getGenesisHash", "getMultipleAccounts", "getMinimumBalanceForRentExemption", "getLatestBlockhash", "getFeeForMessage", "simulateTransaction"].includes(method));
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }), signal: AbortSignal.timeout(30000) });
    if (res.status === 429 && attempt < 2) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
    assert(res.ok, "Devnet RPC HTTP " + res.status);
    const data = await res.json(); assert(!data.error, method + " failed: " + JSON.stringify(data.error)); return data.result;
  }
}
const genesisHash = await rpc("getGenesisHash");
assert.equal(genesisHash, "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "wrong cluster");
const bufferSeed = lifecycle ? "evm-life-4a2a277a6df0-20261001" : "evm-wd-fee494161131-20260930";
const plannedBuffer = await PublicKey.createWithSeed(authority, bufferSeed, loader);
const addresses = [program, programData, authority, safe, ata, mint, plannedBuffer];
const snapshot = await rpc("getMultipleAccounts", [addresses.map(k => k.toBase58()), { encoding: "base64", commitment: "finalized" }]);
assert.equal(snapshot.value[6], null, "planned buffer already exists: inspect before any upload");
const accounts = snapshot.value.slice(0, 6).map(a => { assert(a, "required account absent"); return { ...a, owner: new PublicKey(a.owner), data: Buffer.from(a.data[0], "base64") }; });
const [prog, data, payer, vault, token, mintAccount] = accounts;
assert(prog.executable && prog.owner.equals(loader) && prog.data.length === 36);
assert.equal(prog.data.readUInt32LE(), 2); assert(new PublicKey(prog.data.subarray(4)).equals(programData));
assert(data.owner.equals(loader) && data.data.length >= 45 && !data.executable);
assert.equal(data.data.readUInt32LE(), 3); assert.equal(data.data[12], 1);
assert(new PublicKey(data.data.subarray(13, 45)).equals(authority), "upgrade authority changed");
assert.equal(sha256(data.data.subarray(45)), expectedOldHash, "deployed binary changed; review again");
assert(payer.owner.equals(SystemProgram.programId) && payer.data.length === 0);
assert(vault.owner.equals(program) && vault.data.length === 705);
const idl = JSON.parse(readFileSync(new URL("../src/idl/yield_vault_evm_devnet.json", import.meta.url)));
const decoded = new BorshAccountsCoder(idl).decode("EvmVault", vault.data);
assert(Buffer.from(decoded.eth_address).equals(ownerBytes));
const source = unpackAccount(ata, token, TOKEN_PROGRAM_ID), usdc = unpackMint(mint, mintAccount, TOKEN_PROGRAM_ID);
assert(source.owner.equals(safe) && source.mint.equals(mint) && source.isInitialized && !source.isFrozen);
assert.equal(usdc.decimals, 6); assert.equal(source.delegate, null); assert.equal(source.closeAuthority, null);
assert(lifecycle ? source.amount <= 900000n : source.amount === 0n, "Safe balance changed beyond reviewed recovery amount");
const minimumProgramDataBytes = binary.length + 45, bufferBytes = binary.length + 37;
const neededBytes = Math.max(0, minimumProgramDataBytes - data.data.length);
const additionalBytes = neededBytes ? Math.max(10240, neededBytes) : 0;
const requiredBytes = data.data.length + additionalBytes;
const [requiredRent, bufferMinimumRent] = await Promise.all([
  rpc("getMinimumBalanceForRentExemption", [requiredBytes, { commitment: "finalized" }]),
  rpc("getMinimumBalanceForRentExemption", [bufferBytes, { commitment: "finalized" }]),
]);
// Solana CLI 3.1.12 funds the buffer with size_of_programdata rent (8 bytes more than its own minimum).
const bufferFunding = await rpc("getMinimumBalanceForRentExemption", [minimumProgramDataBytes, { commitment: "finalized" }]), extensionRent = Math.max(0, requiredRent - data.lamports);
const blockhash = (await rpc("getLatestBlockhash", [{ commitment: "finalized" }])).value.blockhash;
function tx(ixs) { return new Transaction({ feePayer: authority, recentBlockhash: blockhash }).add(...ixs); }
async function fee(transaction) { const result = await rpc("getFeeForMessage", [transaction.serializeMessage().toString("base64"), { commitment: "finalized" }]); assert(result.value !== null); return result.value; }
const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 })];
const extensions = [];
if (additionalBytes) for (const checked of [true, false]) {
  const bytes = Buffer.alloc(8); bytes.writeUInt32LE(checked ? 9 : 6, 0); bytes.writeUInt32LE(additionalBytes, 4);
  const keys = [{ pubkey: programData, isSigner: false, isWritable: true }, { pubkey: program, isSigner: false, isWritable: true }];
  if (checked) keys.push({ pubkey: authority, isSigner: true, isWritable: true });
  keys.push({ pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: authority, isSigner: true, isWritable: true });
  const transaction = tx([...budget, new TransactionInstruction({ programId: loader, keys, data: bytes })]);
  const serialized = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  const result = await rpc("simulateTransaction", [serialized, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "finalized",
    accounts: { encoding: "base64", addresses: [programData.toBase58(), authority.toBase58()] } }]);
  const post = result.value.accounts;
  if (!result.value.err) {
    assert.equal(Buffer.from(post[0].data[0], "base64").length, requiredBytes);
    assert.equal(post[0].lamports - data.lamports, extensionRent);
  }
  extensions.push({ instruction: checked ? "ExtendProgramChecked" : "ExtendProgram", error: result.value.err, unitsConsumed: result.value.unitsConsumed,
    feeLamports: await fee(transaction), resultingProgramDataBytes: !result.value.err ? requiredBytes : null, logs: result.value.logs });
}
if (additionalBytes && !extensions.some(e => !e.error)) console.error(JSON.stringify({status:"extension_simulation_blocked",additionalBytes,extensions},null,2));
assert(!additionalBytes || extensions.some(e => !e.error), "neither extension simulation passed");
// A public seeded buffer address needs only the existing base/payer signer; no new private key.
const placeholder = plannedBuffer;
function writeIx(length) {
  const bytes = Buffer.alloc(16 + length); bytes.writeUInt32LE(1, 0); bytes.writeBigUInt64LE(BigInt(length), 8);
  return new TransactionInstruction({ programId: loader, keys: [{ pubkey: placeholder, isSigner: false, isWritable: true }, { pubkey: authority, isSigner: true, isWritable: false }], data: bytes });
}
// Conservative sizing includes both compute limit and zero-price instructions, even if CLI omits price=0.
const initial = tx([...budget,
  await SystemProgram.createAccountWithSeed({ fromPubkey: authority, newAccountPubkey: placeholder, basePubkey: authority, seed: bufferSeed, lamports: bufferFunding, space: bufferBytes, programId: loader }),
  new TransactionInstruction({ programId: loader, keys: [
    { pubkey: placeholder, isSigner: false, isWritable: true }, { pubkey: authority, isSigner: false, isWritable: false }
  ], data: Buffer.alloc(4) })]);
const initialSimulation = (await rpc("simulateTransaction", [initial.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
  { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "finalized",
    accounts: { encoding: "base64", addresses: [placeholder.toBase58()] } }])).value;
assert.equal(initialSimulation.err, null, "buffer creation simulation failed");
assert.equal(Buffer.from(initialSimulation.accounts[0].data[0], "base64").length, bufferBytes);
assert.equal(initialSimulation.accounts[0].lamports, bufferFunding);
const initialFee = await fee(initial);
const writeOverhead = tx([...budget, writeIx(0)]).serialize({ requireAllSignatures: false, verifySignatures: false }).length;
const writeChunkBytes = 1232 - writeOverhead - 1;
assert(writeChunkBytes >= 800);
const writeTransactionsUpperBound = Math.ceil(binary.length / writeChunkBytes);
const writeFee = await fee(tx([...budget, writeIx(writeChunkBytes)]));
// Seeded buffer creation, writes, final upgrade and extension each need only the existing payer/authority signature.
const singlePassFeeUpperBound = writeTransactionsUpperBound * writeFee + initialFee + 5000 + (additionalBytes ? 5000 : 0);
const feeCap = 50000000; // 0.05 test SOL, operation cap including retries; requires separate approval.
const peakFundingWithCap = bufferFunding + extensionRent + feeCap;
assert(payer.lamports >= peakFundingWithCap, "payer cannot cover reviewed budget");
console.log(JSON.stringify({ status: "read_only_preflight_ok", observedAt: new Date().toISOString(), cluster: "devnet", genesisHash,
  finalizedSlot: snapshot.context.slot, program: program.toBase58(), programData: programData.toBase58(), upgradeAuthorityAndPayer: authority.toBase58(),
  payerLamports: payer.lamports, lastUpgradeSlot: data.data.readBigUInt64LE(4).toString(), currentProgramDataBytes: data.data.length,
  currentDeployedElfBytes: data.data.length - 45, currentDeployedElfSha256: expectedOldHash, reviewedElfBytes: binary.length, reviewedElfSha256: expectedNewHash,
  requiredProgramDataBytes: requiredBytes, additionalBytes, requiredProgramDataRentLamports: requiredRent, additionalProgramDataRentLamports: extensionRent,
  plannedBuffer: plannedBuffer.toBase58(), bufferSeed, bufferAlreadyExists: false, bufferBytes, bufferMinimumRentLamports: bufferMinimumRent, cliBufferFundingLamports: bufferFunding,
  writeChunkBytes, writeTransactionsUpperBound, writeFeeLamports: writeFee, singlePassFeeUpperBoundLamports: singlePassFeeUpperBound,
  proposedFeeCapLamports: feeCap, peakFundingWithCapLamports: peakFundingWithCap, netSpendWithFeeCapLamports: extensionRent + feeCap,
  bufferCreationSimulation: { error: initialSimulation.err, unitsConsumed: initialSimulation.unitsConsumed, feeLamports: initialFee, accountPersisted: false },
  extensions, safe: { owner, address: safe.toBase58(), ata: ata.toBase58(), rentPayer: decoded.rent_payer.toBase58(), nonce: decoded.nonce.toString(),
    allocationBps: decoded.allocation_bps, usdcRaw: source.amount.toString() },
  upgradeAllowedAfterFullRecovery: source.amount === 0n,
  fullUpgradeSimulation: "not performed: new buffer not allocated/uploaded", transactionSent: false, walletFilesRead: false }, null, 2));
