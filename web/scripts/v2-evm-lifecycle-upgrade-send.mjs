/** One reviewed manual Devnet upgrade. Protected existing operator key stays local. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, fsyncSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import bs58 from "bs58";

const program = new PublicKey("8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5");
const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const authority = new PublicKey("8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A");
const [programData] = PublicKey.findProgramAddressSync([program.toBuffer()], loader);
const safe = new PublicKey("B9TDuTrEihNcX2StDwGn4qua6Dd921P9GLxoPgaF7WNu"), ata = new PublicKey("DGMgUNQ3VeBoU4HxCYfxtqhg93Zjt2dyEHQCxgJfu7WK");
const seed = "evm-life-4a2a277a6df0-20261001", buffer = await PublicKey.createWithSeed(authority, seed, loader);
assert.equal(buffer.toBase58(), "2HGHeWBCe1b5MDr4c4jwYocUKJ2WXfxzPkpi6o5eo2dV");
const oldHash = "fee494161131cc44fb572f3bcbf5b019170b4414a41221b614f6337b5aaa7489", newHash = "4a2a277a6df06bbcafe172f90ff88bfc3d31fe34b4309b2b6913a4d7b70fdf98";
const binary = readFileSync(new URL("../../target/deploy/yield_vault.so", import.meta.url)), hash = d => createHash("sha256").update(d).digest("hex");
assert.equal(binary.length, 695488); assert.equal(hash(binary), newHash);
assert(process.argv.includes("--send-reviewed") && process.env.V2_EVM_UPGRADE_ACK === "APPROVED_DEVNET_EVM_LIFECYCLE_UPGRADE_4A2A", "reviewed upgrade approval acknowledgement required");
const endpoint = process.env.V2_DEVNET_RPC_URL || "https://api.devnet.solana.com";
assert.equal(new URL(endpoint).protocol, "https:");
const funding = 3533957880, maxExtensionRent = 52019200, feeCap = 50000000, peakCap = 3635977080, reviewedCapacity = 699149;
const journalPath = fileURLToPath(new URL("../../target/deploy/evm-lifecycle-upgrade-journal.json", import.meta.url));
let journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, "utf8")) : {
  cluster: "devnet", program: program.toBase58(), buffer: buffer.toBase58(), authority: authority.toBase58(), elfSha256: newHash,
  approvedFeeCapLamports: feeCap, createdAt: new Date().toISOString(), transactions: [] };
assert.equal(journal.elfSha256, newHash); assert.equal(journal.program, program.toBase58()); assert.equal(journal.buffer, buffer.toBase58());
function save() { const fd=openSync(journalPath+".tmp","w",0o600); try { writeFileSync(fd,JSON.stringify(journal,null,2)+"\n");fsyncSync(fd); } finally {closeSync(fd);} renameSync(journalPath+".tmp",journalPath); const dir=openSync(fileURLToPath(new URL("../../target/deploy/",import.meta.url)),"r");try{fsyncSync(dir);}finally{closeSync(dir);} }
function emit(item) { console.log(JSON.stringify(item)); }
const pause = ms => new Promise(r => setTimeout(r, ms));
let rpcId = 0, nextRpc = 0;
async function rpc(method, params = []) {
  assert(["getGenesisHash", "getMultipleAccounts", "getLatestBlockhash", "getMinimumBalanceForRentExemption", "getFeeForMessage", "simulateTransaction", "sendTransaction", "getSignatureStatuses", "getTransaction", "getBlockHeight"].includes(method));
  for (let n = 0; n < 4; n++) {
    await pause(Math.max(0, nextRpc - Date.now())); nextRpc = Date.now() + 220;
    let res;
    try { res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }), signal: AbortSignal.timeout(30000) }); }
    catch { throw Error("RPC transport error during " + method + "; inspect journal/signature before retry"); }
    if (res.status === 429 && n < 3) { await pause(1500 * (n + 1)); continue; }
    assert(res.ok, method + " HTTP " + res.status);
    const payload = await res.json();
    if (payload.error) throw Error(method + " RPC error " + payload.error.code + ": " + JSON.stringify(payload.error.data || null));
    return payload.result;
  }
}
async function accounts(keys, commitment = "finalized") {
  const r = await rpc("getMultipleAccounts", [keys.map(k => k.toBase58()), { encoding: "base64", commitment }]);
  return { slot: r.context.slot, value: r.value.map(a => a && { ...a, data: Buffer.from(a.data[0], "base64") }) };
}
function checkProgram(p, d, expectedHash = oldHash) {
  assert(p && p.owner === loader.toBase58() && p.executable && p.data.readUInt32LE() === 2 && new PublicKey(p.data.subarray(4)).equals(programData));
  assert(d && d.owner === loader.toBase58() && d.data.readUInt32LE() === 3 && d.data[12] === 1 && new PublicKey(d.data.subarray(13, 45)).equals(authority));
  const size = expectedHash === oldHash ? 688864 : binary.length;
  assert(d.data.length >= 45 + size); assert.equal(hash(d.data.subarray(45,45+size)),expectedHash,"deployed binary changed");
  assert(d.data.subarray(45+size).every(byte=>byte===0),"nonzero reserved program padding");
}
function checkBuffer(b) {
  assert(b && b.owner === loader.toBase58() && b.data.length === binary.length + 37 && b.data.readUInt32LE() === 1 && b.data[4] === 1);
  assert(new PublicKey(b.data.subarray(5, 37)).equals(authority), "buffer authority mismatch"); assert.equal(b.lamports, funding);
}
assert.equal(await rpc("getGenesisHash"), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "wrong cluster");
// Resolve any previously recorded transaction first; never silently repeat an uncertain send.
for (const entry of journal.transactions.filter(t => t.status !== "finalized" && t.status !== "not_sent_local_serialization_error")) {
  const status = (await rpc("getSignatureStatuses", [[entry.signature], { searchTransactionHistory: true }])).value[0];
  assert(status && status.confirmationStatus === "finalized" && !status.err, "unresolved earlier send " + entry.signature + "; inspect before retry");
  entry.status = "finalized"; entry.slot = status.slot;
}
save();
const before = await accounts([program, programData, authority, safe, ata, buffer]);
const [p0, d0, payer0, safe0, ata0, buffer0] = before.value;
if (d0 && hash(d0.data.subarray(45, 45 + binary.length)) === newHash) { checkProgram(p0, d0, newHash); emit({ status: "already_upgraded_read_only", slot: before.slot, sha256: newHash }); process.exit(0); }
checkProgram(p0, d0);
assert([688909, reviewedCapacity].includes(d0.data.length), "reviewed ProgramData capacity changed");
assert(payer0 && payer0.owner === SystemProgram.programId.toBase58()); assert(payer0.lamports >= peakCap, "payer below approved peak funding");
assert(safe0 && safe0.owner === program.toBase58() && safe0.data.length === 705 && safe0.data.readBigUInt64LE(61) === 3n);
assert(ata0 && ata0.data.readBigUInt64LE(64) === 0n, "Safe now funded");
journal.payerBeforeLamports ??= payer0.lamports; journal.safeBeforeSha256 ??= hash(safe0.data); journal.ataBeforeSha256 ??= hash(ata0.data);
assert.equal(journal.safeBeforeSha256, hash(safe0.data)); assert.equal(journal.ataBeforeSha256, hash(ata0.data));
const requiredRent = await rpc("getMinimumBalanceForRentExemption", [binary.length + 45, { commitment: "finalized" }]);
assert(requiredRent <= funding); assert(Math.max(0, requiredRent - d0.lamports) <= maxExtensionRent);
save();
let signer;
try { const secret = Uint8Array.from(JSON.parse(readFileSync(process.env.V2_PAYER_KEYPAIR, "utf8"))); signer = Keypair.fromSecretKey(Uint8Array.from(secret)); secret.fill(0); }
catch { throw Error("Cannot load existing protected operator signer"); }
assert(signer.publicKey.equals(authority), "operator public key mismatch");
let estimatedFees = journal.transactions.filter(t => t.status !== "not_sent_local_serialization_error").reduce((n, t) => n + t.estimatedFeeLamports, 0);
function make(ixs, blockhash) { return new Transaction({ feePayer: authority, recentBlockhash: blockhash }).add(
  ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }), ...ixs); }
async function simulate(t, postKeys = []) {
  const config = { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" };
  if (postKeys.length) config.accounts = { encoding: "base64", addresses: postKeys.map(k => k.toBase58()) };
  const s = (await rpc("simulateTransaction", [t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"), config])).value;
  assert.equal(s.err, null, "simulation failed: " + JSON.stringify(s.err) + " " + (s.logs || []).join(" ")); return s;
}
async function transactionFee(t) {
  const result = await rpc("getFeeForMessage", [t.serializeMessage().toString("base64"), { commitment: "confirmed" }]);
  assert(result.value !== null && result.value <= 5000, "reviewed fee exceeded"); return result.value;
}
async function submit(t, block, action, fee, details = {}) {
  assert(estimatedFees + fee <= feeCap, "approved total fee cap reached"); t.sign(signer);
  const wire = t.serialize().toString("base64"); // Verify signature before journal reservation or any network send.
  const signature = bs58.encode(t.signature), entry = { action, ...details, signature, lastValidBlockHeight: block.lastValidBlockHeight,
    wireBase64: wire, estimatedFeeLamports: fee, status: "prepared", preparedAt: new Date().toISOString() };
  journal.transactions.push(entry); estimatedFees += fee; save();
  // Record before the first RPC send. Only identical bytes may be retransmitted by RPC.
  const returned = await rpc("sendTransaction", [wire, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 2 }]);
  assert.equal(returned, signature); entry.status = "submitted"; save(); return entry;
}
async function confirm(entries) {
  for (let n = 0; n < 90; n++) {
    const values = (await rpc("getSignatureStatuses", [entries.map(e => e.signature), { searchTransactionHistory: true }])).value;
    let all = true;
    for (let i = 0; i < entries.length; i++) {
      const status = values[i]; if (!status || status.confirmationStatus !== "finalized") { all = false; continue; }
      assert.equal(status.err, null, "transaction failed " + entries[i].signature + " " + JSON.stringify(status.err));
      entries[i].status = "finalized"; entries[i].slot = status.slot;
    }
    save(); if (all) return; await pause(1000);
  }
  throw Error("Confirmation unresolved; inspect journal, do not resign blindly");
}
function writeIx(offset, payload) {
  const data = Buffer.alloc(16 + payload.length); data.writeUInt32LE(1); data.writeUInt32LE(offset, 4); data.writeBigUInt64LE(BigInt(payload.length), 8); payload.copy(data, 16);
  return new TransactionInstruction({ programId: loader, keys: [{ pubkey: buffer, isSigner: false, isWritable: true }, { pubkey: authority, isSigner: true, isWritable: false }], data });
}
if (!buffer0) {
  const block = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
  const create = await SystemProgram.createAccountWithSeed({ fromPubkey: authority, newAccountPubkey: buffer, basePubkey: authority, seed, lamports: funding, space: binary.length + 37, programId: loader });
  const init = new TransactionInstruction({ programId: loader, keys: [{ pubkey: buffer, isSigner: false, isWritable: true }, { pubkey: authority, isSigner: false, isWritable: false }], data: Buffer.alloc(4) });
  const t = make([create, init], block.blockhash), simulation = await simulate(t, [buffer]);
  checkBuffer({ ...simulation.accounts[0], data: Buffer.from(simulation.accounts[0].data[0], "base64") });
  emit({ status: "buffer_create_simulation_ok", buffer: buffer.toBase58(), lamports: funding, computeUnits: simulation.unitsConsumed });
  const entry = await submit(t, block, "create_buffer", await transactionFee(t)); await confirm([entry]); emit({ status: "buffer_created_finalized", signature: entry.signature, slot: entry.slot });
} else checkBuffer(buffer0);
let uploaded = (await accounts([buffer])).value[0]; checkBuffer(uploaded);
const chunkSize = 960, writes = [];
for (let offset = 0; offset < binary.length; offset += chunkSize) {
  const payload = binary.subarray(offset, Math.min(offset + chunkSize, binary.length));
  if (!uploaded.data.subarray(37 + offset, 37 + offset + payload.length).equals(payload)) writes.push({ offset, payload });
}
emit({ status: "upload_started", buffer: buffer.toBase58(), remainingWriteTransactions: writes.length, journal: "target/deploy/evm-lifecycle-upgrade-journal.json" });
for (let i = 0; i < writes.length; i += 20) {
  const block = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])).value, entries = [];
  const first = make([writeIx(writes[i].offset, writes[i].payload)], block.blockhash), fee = await transactionFee(first);
  for (const part of writes.slice(i, i + 20)) {
    const t = make([writeIx(part.offset, part.payload)], block.blockhash); await simulate(t);
    entries.push(await submit(t, block, "write_buffer", fee, { offset: part.offset, length: part.payload.length }));
  }
  await confirm(entries); emit({ status: "upload_progress_finalized", completed: Math.min(i + 20, writes.length), total: writes.length, estimatedFeesLamports: estimatedFees });
}
const ready = await accounts([program, programData, authority, safe, ata, buffer]);
const [p1, d1, payer1, safe1, ata1, uploaded1] = ready.value;
checkProgram(p1, d1); checkBuffer(uploaded1); assert.equal(hash(uploaded1.data.subarray(37)), newHash, "uploaded ELF hash mismatch");
assert.equal(hash(safe1.data), journal.safeBeforeSha256); assert.equal(hash(ata1.data), journal.ataBeforeSha256);
const liveRent = await rpc("getMinimumBalanceForRentExemption", [reviewedCapacity, { commitment: "finalized" }]);
const extensionRent = Math.max(0, liveRent - d1.lamports); assert(extensionRent <= maxExtensionRent);
assert(payer1.lamports >= extensionRent + 5000);
const additionalBytes = reviewedCapacity - d1.data.length; assert([0,10240].includes(additionalBytes));
if (additionalBytes) {
const extendData = Buffer.alloc(8); extendData.writeUInt32LE(6); extendData.writeUInt32LE(additionalBytes, 4);
const extend = new TransactionInstruction({ programId: loader, keys: [
  { pubkey: programData, isSigner: false, isWritable: true }, { pubkey: program, isSigner: false, isWritable: true },
  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: authority, isSigner: true, isWritable: true }], data: extendData });
// ExtendProgram records this slot; Upgrade must execute in a later slot, so confirm extension first.
const extensionBlock = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
const extensionTx = make([extend], extensionBlock.blockhash), extensionFee = await transactionFee(extensionTx);
const extensionSim = await simulate(extensionTx, [programData, authority]);
assert.equal(Buffer.from(extensionSim.accounts[0].data[0], "base64").length, reviewedCapacity);
assert.equal(extensionSim.accounts[0].lamports - d1.lamports, extensionRent);
emit({ status: "extension_simulation_ok", additionalBytes, extensionRentLamports: extensionRent, feeLamports: extensionFee, unitsConsumed: extensionSim.unitsConsumed });
const extensionEntry = await submit(extensionTx, extensionBlock, "extend_program", extensionFee); await confirm([extensionEntry]);
emit({ status: "extension_finalized", signature: extensionEntry.signature, slot: extensionEntry.slot });
}
const upgradeData = Buffer.alloc(4); upgradeData.writeUInt32LE(3);
const upgrade = new TransactionInstruction({ programId: loader, keys: [
  { pubkey: programData, isSigner: false, isWritable: true }, { pubkey: program, isSigner: false, isWritable: true },
  { pubkey: buffer, isSigner: false, isWritable: true }, { pubkey: authority, isSigner: false, isWritable: true },
  { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
  { pubkey: authority, isSigner: true, isWritable: false }], data: upgradeData });

const extended = await accounts([program, programData, authority, buffer]);
checkProgram(extended.value[0], extended.value[1]); checkBuffer(extended.value[3]);
assert.equal(extended.value[1].data.length, reviewedCapacity); assert.equal(hash(extended.value[3].data.subarray(37)), newHash);
const payerBeforeFinal = extended.value[2];
const block = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
const finalTx = make([upgrade], block.blockhash), finalFee = await transactionFee(finalTx);
const simulated = await simulate(finalTx, [programData, authority, buffer, safe, ata]);
const [sd, sp, sb, sv, sa] = simulated.accounts;
assert.equal(Buffer.from(sd.data[0], "base64").length, reviewedCapacity);
assert.equal(hash(Buffer.from(sd.data[0], "base64").subarray(45,45+binary.length)), newHash);
assert(Buffer.from(sd.data[0],"base64").subarray(45+binary.length).every(byte=>byte===0));
assert.equal(hash(Buffer.from(sv.data[0], "base64")), journal.safeBeforeSha256); assert.equal(hash(Buffer.from(sa.data[0], "base64")), journal.ataBeforeSha256);
assert.equal(sp.lamports, payerBeforeFinal.lamports - finalFee + funding); assert(!sb || sb.lamports === 0);
journal.finalSimulation = { error: simulated.err, unitsConsumed: simulated.unitsConsumed, additionalBytes, extensionRentLamports: extensionRent,
  feeLamports: finalFee, expectedPayerLamportsAfter: sp.lamports, bufferHash: newHash, observedAt: new Date().toISOString() }; save();
emit({ status: "final_upgrade_simulation_ok", ...journal.finalSimulation });
// The program binary used in this send is exactly the reviewed and hashed buffer.
const finalEntry = await submit(finalTx, block, "upgrade_program", finalFee); await confirm([finalEntry]);
emit({ status: "upgrade_finalized", signature: finalEntry.signature, slot: finalEntry.slot });
const receipt = await rpc("getTransaction", [finalEntry.signature, { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 }]);
assert(receipt && !receipt.meta.err); assert.equal(receipt.meta.fee, finalFee);
const after = await accounts([program, programData, authority, safe, ata, buffer]); const [p2, d2, payer2, safe2, ata2, buffer2] = after.value;
checkProgram(p2, d2, newHash); assert.equal(d2.data.length, reviewedCapacity); assert.equal(d2.data.readBigUInt64LE(4), BigInt(receipt.slot));
assert.equal(hash(safe2.data), journal.safeBeforeSha256); assert.equal(hash(ata2.data), journal.ataBeforeSha256); assert.equal(buffer2, null);
const actualNetSpend = journal.payerBeforeLamports - payer2.lamports;
assert(actualNetSpend <= maxExtensionRent + feeCap, "approved net spend exceeded");
journal.completedAt = new Date().toISOString(); journal.status = "verified_finalized";
journal.result = { transaction: finalEntry.signature, finalizedSlot: receipt.slot, feeLamports: receipt.meta.fee, totalEstimatedTransactionFeesLamports: estimatedFees,
  programDataBytes: d2.data.length, elfSha256: newHash, upgradeAuthority: authority.toBase58(), bufferAbsent: true, payerAfterLamports: payer2.lamports,
  netSpendLamports: actualNetSpend, safeNonce: safe2.data.readBigUInt64LE(61).toString(), safeUsdcRaw: ata2.data.readBigUInt64LE(64).toString(),
  safeUnchanged: true, ataUnchanged: true, sourceFinalizedReadSlot: after.slot }; save(); emit({ status: journal.status, ...journal.result });
