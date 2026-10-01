/** Read-only preflight for the reviewed test-USDC recovery deposit. No signer files. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { PublicKey, Transaction } from "@solana/web3.js";
import { BorshAccountsCoder } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount, unpackMint, createTransferCheckedInstruction } from "@solana/spl-token";
const program = new PublicKey("8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5"), loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const payer = new PublicKey("8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A"), mint = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const owner = "0xb659DA13418527601C52D4220536C12397F20855", ownerBytes = Buffer.from(owner.slice(2), "hex");
const [safe] = PublicKey.findProgramAddressSync([Buffer.from("vault_evm"), ownerBytes], program), destination = getAssociatedTokenAddressSync(mint, safe, true);
const source = getAssociatedTokenAddressSync(mint, payer), [programData] = PublicKey.findProgramAddressSync([program.toBuffer()], loader);
assert.equal(safe.toBase58(), "bn4KYuYg6fvbqPEh13rC1Exr5HuPCC455KiC1dTEnEr"); assert.equal(destination.toBase58(), "rQUE1MGE7jwzyCoUdWTphYKP28hjU3QqcnMjnGCwLxm");
assert.equal(source.toBase58(), "GfSmEbCHJ9qsYLUcSL8aedFmnQKAC1cq54MWYYbnx5Un");
const endpoint = process.env.V2_DEVNET_RPC_URL || "https://api.devnet.solana.com"; assert.equal(new URL(endpoint).protocol, "https:");
let id = 0;
async function rpc(method, params = []) {
  assert(["getGenesisHash", "getMultipleAccounts", "getLatestBlockhash", "getFeeForMessage", "simulateTransaction"].includes(method));
  const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(60000) });
  assert(res.ok, "RPC HTTP " + res.status); const r = await res.json(); assert(!r.error, "RPC method failed: " + method); return r.result;
}
const genesisHash = await rpc("getGenesisHash"); assert.equal(genesisHash, "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
const addresses = [program, programData, payer, safe, source, destination, mint];
const state = await rpc("getMultipleAccounts", [addresses.map(k => k.toBase58()), { encoding: "base64", commitment: "finalized" }]);
const info = state.value.map(a => a && { ...a, owner: new PublicKey(a.owner), data: Buffer.from(a.data[0], "base64") });
const [prog, pd, payerInfo, vault, sourceInfo, destInfo, mintInfo] = info;
assert(prog && prog.executable && prog.owner.equals(loader) && new PublicKey(prog.data.subarray(4)).equals(programData));
assert(pd && pd.owner.equals(loader) && pd.data.length === 699149 && pd.data.readUInt32LE() === 3 && pd.data[12] === 1);
assert(new PublicKey(pd.data.subarray(13, 45)).equals(payer));
assert.equal(createHash("sha256").update(pd.data.subarray(45, 45 + 695488)).digest("hex"), "4a2a277a6df06bbcafe172f90ff88bfc3d31fe34b4309b2b6913a4d7b70fdf98");
assert(pd.data.subarray(45 + 695488).every(byte => byte === 0), "unexpected program padding");
assert(vault && vault.owner.equals(program) && vault.data.length === 705);
const idl = JSON.parse(readFileSync(new URL("../src/idl/yield_vault_evm_devnet.json", import.meta.url)));
const decoded = new BorshAccountsCoder(idl).decode("EvmVault", vault.data); assert(Buffer.from(decoded.eth_address).equals(ownerBytes));
const amount = 1000000n;
assert(decoded.rent_payer.equals(new PublicKey("GhK2bfKSsFgVrm6RbgHZkMzQ34pvYh5tGjfda3UchY1s")), "creation sponsor mismatch");
const amountUsdc = "1.000000";
assert(sourceInfo, "Operator test-USDC source missing");
 const s = unpackAccount(source, sourceInfo, TOKEN_PROGRAM_ID), d = unpackAccount(destination, destInfo, TOKEN_PROGRAM_ID), m = unpackMint(mint, mintInfo, TOKEN_PROGRAM_ID);
assert(s.owner.equals(payer) && s.mint.equals(mint) && s.isInitialized && !s.isFrozen && !s.delegate && !s.closeAuthority);
assert(d.owner.equals(safe) && d.mint.equals(mint) && d.isInitialized && !d.isFrozen && !d.delegate && !d.closeAuthority); assert.equal(m.decimals, 6);
console.log(JSON.stringify({ status: "source_checked", operator: payer.toBase58(), source: source.toBase58(), sourceUsdcRaw: s.amount.toString(), safeUsdcRaw: d.amount.toString(), nonce: decoded.nonce.toString() }));
assert(s.amount >= amount, "operator test-USDC balance below approved amount"); assert.equal(d.amount, 0n, "Safe already funded: inspect before another deposit"); assert.equal(decoded.nonce.toString(), "1");
const latest = (await rpc("getLatestBlockhash", [{ commitment: "finalized" }])).value;
const transaction = new Transaction({ feePayer: payer, recentBlockhash: latest.blockhash }).add(createTransferCheckedInstruction(source, mint, destination, payer, amount, 6, [], TOKEN_PROGRAM_ID));
const fee = (await rpc("getFeeForMessage", [transaction.serializeMessage().toString("base64"), { commitment: "finalized" }])).value;
assert(fee !== null && fee <= 5000 && payerInfo.lamports >= fee);
const sim = (await rpc("simulateTransaction", [transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "finalized", accounts: { encoding: "base64", addresses: [source.toBase58(), destination.toBase58(), safe.toBase58()] } }])).value;
assert.equal(sim.err, null, "deposit simulation failed");
const post = sim.accounts.map(a => ({ ...a, owner: new PublicKey(a.owner), data: Buffer.from(a.data[0], "base64") }));
assert.equal(unpackAccount(source, post[0], TOKEN_PROGRAM_ID).amount, s.amount - amount); assert.equal(unpackAccount(destination, post[1], TOKEN_PROGRAM_ID).amount, d.amount + amount); assert(post[2].data.equals(vault.data));
const result = { status: "deposit_preflight_ok", observedAt: new Date().toISOString(), cluster: "devnet", genesisHash, action: "transfer_checked_test_usdc_to_evm_safe", program: program.toBase58(), mint: mint.toBase58(), decimals: 6,
  operatorAndFeePayer: payer.toBase58(), source: source.toBase58(), sourceBeforeRaw: s.amount.toString(), sourceExpectedAfterRaw: (s.amount - amount).toString(),
  evmOwner: owner, safe: safe.toBase58(), destination: destination.toBase58(), destinationBeforeRaw: d.amount.toString(), destinationExpectedAfterRaw: (d.amount + amount).toString(),
  amountRaw: amount.toString(), amountUsdc, safeNonce: decoded.nonce.toString(), feeLamports: fee, rentLamports: 0, simulationError: sim.err, computeUnits: sim.unitsConsumed, finalizedReadSlot: state.context.slot, transactionSent: false };
writeFileSync(new URL("../../docs/yield-ai-v2-evm-new-owner-deposit-preflight.json", import.meta.url), JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result, null, 2));

export { transaction, result, rpc, source, destination, safe, payer, vault, s, d, amount };
