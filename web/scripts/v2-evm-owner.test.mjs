import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { BorshAccountsCoder } from "@coral-xyz/anchor";
import { privateKeyToAccount } from "viem/accounts";
import { hashTypedData, recoverTypedDataAddress } from "viem";

const require = createRequire(import.meta.url);
const helperPath = fileURLToPath(new URL("../src/lib/v2EvmDevnet.ts", import.meta.url));
const helperModule = new Module(helperPath); helperModule.filename = helperPath; helperModule.paths = require.resolve.paths("viem");
helperModule._compile(ts.transpileModule(readFileSync(helperPath,"utf8"), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,helperPath);
const helper = helperModule.exports;
const idl = JSON.parse(readFileSync(new URL("../src/idl/yield_vault_evm_devnet.json", import.meta.url)));
const vector = JSON.parse(readFileSync(new URL("../../programs/yield-vault/tests/fixtures/evm-withdraw.json", import.meta.url)));
const coder = new BorshAccountsCoder(idl);
const signer = privateKeyToAccount("0x" + randomBytes(32).toString("hex"));
const { safe, ownerBytes } = helper.deriveEvmSafe(signer.address);
const recipient = new PublicKey(vector.recipientTokenAccount), authority = new PublicKey(vector.recipientOwner);
let stateNonce = 6n, exists = true, balance = 300000n, recipientOwner = authority, recipientMint = helper.EVM_DEVNET_USDC_MINT;
let rpcFailure = false, recipientMissing = false, genesis = helper.EVM_DEVNET_GENESIS;
class Connection {
  async getGenesisHash() { if (rpcFailure) throw Error("offline"); return genesis; }
  async getAccountInfo() {
    if (!exists) return null;
    return { owner: helper.EVM_DEVNET_PROGRAM, data: await coder.encode("EvmVault", {
      bump: 255, eth_address: [...ownerBytes], rent_payer: authority, nonce: new BN(stateNonce.toString()),
      agent: PublicKey.default, allocation_bps: [5000,0,0,0,0,0,0,0], last_rebalance_ts: new BN(0), allowed_programs: [], route_principal: Array(8).fill(new BN(0)),
    }) };
  }
}
async function getAccount(_connection, address) {
  if (address.equals(recipient)) {
    if (recipientMissing) { const e = Error("missing"); e.name = "TokenAccountNotFoundError"; throw e; }
    return { owner: recipientOwner, mint: recipientMint, amount: 0n, isFrozen: false };
  }
  return { owner: safe, mint: helper.EVM_DEVNET_USDC_MINT, amount: balance, isFrozen: false };
}
const routePath = fileURLToPath(new URL("../src/app/api/v2/evm-devnet/route.ts", import.meta.url));
const mod = new Module(routePath); mod.filename = routePath; mod.paths = require.resolve.paths("next");
mod.require = (id) => id === "@/lib/v2EvmDevnet" ? helper : id === "@/idl/yield_vault_evm_devnet.json" ? idl
  : id === "@solana/web3.js" ? { ...require(id), Connection } : id === "@solana/spl-token" ? { ...require(id), getAccount } : require(id);
mod._compile(ts.transpileModule(readFileSync(routePath, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, routePath);
const { POST } = mod.exports;
function malleate(signature) {
  const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const s = BigInt("0x" + signature.slice(66,130));
  return "0x" + signature.slice(2,66) + (order-s).toString(16).padStart(64,"0") + (signature.slice(130) === "1b" ? "1c" : "1b");
}
async function intent() {
  const deadline = BigInt(Math.floor(Date.now()/1000)+600);
  const typed = helper.withdrawalTypedData(safe, helper.EVM_DEVNET_USDC_MINT, 100000n, recipient, authority, 7n, deadline);
  return { action: "withdraw_usdc", cluster: "devnet", program: helper.EVM_DEVNET_PROGRAM.toBase58(), genesisHash: helper.EVM_DEVNET_GENESIS,
    owner: signer.address, safe: safe.toBase58(), mint: helper.EVM_DEVNET_USDC_MINT.toBase58(), amountRaw: "100000",
    recipientTokenAccount: recipient.toBase58(), recipientOwner: authority.toBase58(), nonce: "7", deadline: deadline.toString(), signature: await signer.signTypedData(typed) };
}
async function post(input, origin="https://lab.test") {
  const response = await POST(new Request("https://lab.test/api/v2/evm-devnet", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(input) }));
  return { status: response.status, body: await response.json() };
}
test.beforeEach(() => { stateNonce=6n; exists=true; balance=300000n; recipientOwner=authority; recipientMint=helper.EVM_DEVNET_USDC_MINT; rpcFailure=false; recipientMissing=false; genesis=helper.EVM_DEVNET_GENESIS; process.env.V2_EVM_DEVNET_WITHDRAW_ENABLED="true"; });

test("independent viem vector matches the Rust digest and signer", async () => {
  const td = helper.withdrawalTypedData(new PublicKey(vector.safe), new PublicKey(vector.mint), BigInt(vector.amountRaw), new PublicKey(vector.recipientTokenAccount), authority, 7n, 2000000000n);
  assert.equal(hashTypedData(td), vector.digest);
  assert.equal(await recoverTypedDataAddress({...td, signature:vector.signature}), vector.owner);
  for (const signature of [vector.wrongClusterSignature, vector.wrongProgramSignature, vector.allocationSignature]) assert.notEqual(await recoverTypedDataAddress({...td, signature}), vector.owner);
});
test("valid withdrawal verifies without sending a transaction", async () => {
  const value=await intent(), result=await post(value);
  assert.equal(result.status,200); assert.equal(result.body.relayMode,"operator"); assert.deepEqual(result.body.intent,value);
  assert.equal(result.body.digest, await helper.verifyEvmIntentSignature(value));
});
test("equivalent high-s signature is rejected before RPC for both actions", async () => {
  const value=await intent(); value.signature=malleate(value.signature); rpcFailure=true;
  const result=await post(value); assert.equal(result.status,400); assert.match(result.body.error,/low-s/);
  assert.throws(()=>helper.assertCanonicalEvmSignature(value.signature),/low-s/);
});
test("amount, account, authority and signer tampering are rejected", async () => {
  const original=await intent();
  for (const patch of [{amountRaw:"100001"},{recipientOwner:PublicKey.default.toBase58()},{signature:"0x"+"00".repeat(65)},{recipientTokenAccount:PublicKey.default.toBase58()}]) assert.equal((await post({...original,...patch})).status,400);
  const td=helper.withdrawalTypedData(safe,helper.EVM_DEVNET_USDC_MINT,100000n,recipient,authority,7n,BigInt(original.deadline));
  const other=privateKeyToAccount("0x"+randomBytes(32).toString("hex"));
  assert.equal((await post({...original,signature:await other.signTypedData(td)})).status,400);
});
test("program, cluster, Safe, mint and action substitutions fail closed", async () => {
  const original=await intent();
  for (const patch of [{program:PublicKey.default.toBase58()},{cluster:"mainnet"},{genesisHash:"wrong"},{safe:PublicKey.default.toBase58()},{mint:PublicKey.default.toBase58()},{action:"withdraw_all"}]) assert.equal((await post({...original,...patch})).status,400);
});
test("nonce replay, expiry and excessive deadline are rejected", async () => {
  const original=await intent(); stateNonce=7n; assert.equal((await post(original)).status,409); stateNonce=6n;
  for (const deadline of ["0",String(Math.floor(Date.now()/1000)+901)]) assert.equal((await post({...original,deadline})).status,400);
});
test("balance, missing Safe and recipient account validation reject withdrawal", async () => {
  const original=await intent(); balance=99999n; assert.equal((await post(original)).status,400); balance=300000n;
  exists=false; assert.equal((await post(original)).status,409); exists=true;
  recipientMissing=true; assert.equal((await post(original)).status,400); recipientMissing=false;
  recipientOwner=PublicKey.default; assert.equal((await post(original)).status,400); recipientOwner=authority;
  recipientMint=PublicKey.default; assert.equal((await post(original)).status,400);
});
test("withdrawal gate defaults closed, while RPC failure is unavailable", async () => {
  const original=await intent(); delete process.env.V2_EVM_DEVNET_WITHDRAW_ENABLED; assert.equal((await post(original)).status,403);
  process.env.V2_EVM_DEVNET_WITHDRAW_ENABLED="true"; rpcFailure=true; assert.equal((await post(original)).status,503); rpcFailure=false;
  genesis="not-devnet"; assert.equal((await post(original)).status,503);
});
test("legacy allocation verifies and uses the same next-nonce convention", async () => {
  const deadline=BigInt(Math.floor(Date.now()/1000)+600), allocationBps=[5000,0,0,0,0,0,0,0];
  const value={owner:signer.address,safe:safe.toBase58(),allocationBps,nonce:"7",deadline:deadline.toString(),signature:await signer.signTypedData(helper.allocationTypedData(safe,allocationBps,7n,deadline))};
  assert.equal((await post(value)).status,200);
  assert.equal((await post({...value,signature:malleate(value.signature)})).status,400);
  stateNonce=7n; assert.equal((await post(value)).status,409);
});
test("raw u64 values never round through Number; malformed inputs fail", async () => {
  assert.equal(helper.decimalU64("9007199254740993","amountRaw"),9007199254740993n);
  assert.equal(helper.decimalU64("18446744073709551615","amountRaw"),helper.U64_MAX);
  for (const value of [1,"-1","1.0","01","18446744073709551616"]) assert.throws(()=>helper.decimalU64(value,"amountRaw"));
  const value=await intent(); for (const amountRaw of ["0","-1","0.1","18446744073709551616"]) assert.equal((await post({...value,amountRaw})).status,400);
  assert.equal((await post(null)).status,400); assert.equal((await post(value,"https://other.test")).status,403);
});

async function lifecycle(action, nonce=action==="create_safe"?"1":"7") {
  const deadline=String(Math.floor(Date.now()/1000)+600), rentPayer=authority.toBase58();
  const value={action,cluster:"devnet",program:helper.EVM_DEVNET_PROGRAM.toBase58(),genesisHash:helper.EVM_DEVNET_GENESIS,owner:signer.address,safe:safe.toBase58(),nonce,deadline,
    ...(action==="create_safe"?{mint:helper.EVM_DEVNET_USDC_MINT.toBase58(),rentPayer}:{})};
  return {...value,signature:await signer.signTypedData(helper.lifecycleTypedData(safe,BigInt(nonce),BigInt(deadline),action==="create_safe"?authority:undefined))};
}
test("signed creation requires explicit lifecycle gate, missing Safe and unchanged sponsor",async()=>{
  exists=false; delete process.env.V2_EVM_DEVNET_LIFECYCLE_ENABLED; const value=await lifecycle("create_safe");
  assert.equal((await post(value)).status,403); process.env.V2_EVM_DEVNET_LIFECYCLE_ENABLED="true";process.env.V2_EVM_DEVNET_SPONSOR=authority.toBase58();
  assert.equal((await post(value)).status,200);exists=true;assert.equal((await post(value)).status,409);exists=false;
  process.env.V2_EVM_DEVNET_SPONSOR=PublicKey.default.toBase58();assert.equal((await post(value)).status,400);
  assert.equal((await post({...value,rentPayer:PublicKey.default.toBase58()})).status,400);
});
test("cancellation verifies a separate action and rejects replay or missing Safe",async()=>{
  process.env.V2_EVM_DEVNET_LIFECYCLE_ENABLED="true"; const value=await lifecycle("cancel_intents");
  assert.equal((await post(value)).status,200);stateNonce=7n;assert.equal((await post(value)).status,409);stateNonce=6n;
  exists=false;assert.equal((await post(value)).status,409);exists=true;
  assert.equal((await post({...value,signature:(await intent()).signature})).status,400);
});
test("allocation never implicitly creates a missing Safe",async()=>{
  exists=false; const deadline=BigInt(Math.floor(Date.now()/1000)+600),allocationBps=[5000,0,0,0,0,0,0,0];
  const value={owner:signer.address,safe:safe.toBase58(),allocationBps,nonce:"1",deadline:deadline.toString(),signature:await signer.signTypedData(helper.allocationTypedData(safe,allocationBps,1n,deadline))};
  assert.equal((await post(value)).status,409);
});
