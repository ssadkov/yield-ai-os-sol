import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { protocolRequest, selectPositionAmount } from "../src/lib/mobileProtocolRequest.ts";
import { mobilePublicPath, mobileOriginAllowed } from "../src/lib/mobilePublicAccess.ts";
import { EXPONENT, exponentAccounts, assertExponentInstruction, rawAmount, minimum, exitBasis } from "../src/lib/exponentV2.ts";
const owner = new PublicKey("EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2");
test("protocol requests reject authority, foreign market controls and non-Solana owners", () => {
  const body = { owner: { type: "solana", address: String(owner) } };
  assert.equal(String(protocolRequest(body, []).owner), String(owner));
  for (const key of ["authority", "rpc", "programId", "recipient", "executor"]) assert.throws(() => protocolRequest({ ...body, [key]: String(owner) }, []));
  assert.throws(() => protocolRequest({ owner: { type: "evm", address: "0x123" } }, []));
});
test("partial/full PT selection stays exact and rejects ambiguous or excessive exits", () => {
  assert.equal(selectPositionAmount({ percent: "50.00" }, 533605537n), 266802768n);
  assert.equal(selectPositionAmount({ shares: "all" }, 533605537n), 533605537n);
  assert.equal(selectPositionAmount({ shares: "1" }, 533605537n), 1n);
  assert.equal(selectPositionAmount({ shares: "all" }, 0n), 0n);
  for (const value of [{}, { shares: "1", percent: "50" }, { percent: "100.01" }, { percent: 50 }, { percent: "0" }, { shares: "534000000" }, { shares: "-1" }]) assert.throws(() => selectPositionAmount(value, 533605537n));
});
test("public project excludes legacy agent/bridge/admin surfaces and origin grants stay explicit", () => {
  for (const path of ["/api/mobile/v1/config", "/api/mobile/v1/protocols/exponent/withdrawals/plan", "/v2/mobile", "/_next/static/app.js"]) assert.equal(mobilePublicPath(path), true);
  for (const path of ["/api/cron/rebalance", "/api/v2/cctp", "/v2/safe", "/api/mobile/v1-other"]) assert.equal(mobilePublicPath(path), false);
  assert.equal(mobileOriginAllowed(null, "https://api.example", ""), true);
  assert.equal(mobileOriginAllowed("https://app.example", "https://api.example", "https://app.example"), true);
  assert.equal(mobileOriginAllowed("https://app.example.evil", "https://api.example", "https://app.example"), false);
});
test("Exponent SDK layouts are checked against reviewed buy/sell/redeem accounts", () => {
  for (const action of ["buy", "sell", "redeem"]) {
    const template = EXPONENT.actions[action];
    const keys = exponentAccounts(action, owner).slice(1).map((key,i) => ({ ...key, isSigner: template.accounts[i].signer }));
    const data = Buffer.alloc(action === "redeem" ? 10 : 19); data[0] = parseInt(template.discriminator,16); data[data.length-1]=10;
    const ix = new TransactionInstruction({ programId: new PublicKey(template.program), keys, data });
    assert.doesNotThrow(() => assertExponentInstruction(action, owner, ix));
    const foreign = new TransactionInstruction({ ...ix, keys: ix.keys.map((k,i) => i===1 ? {...k,pubkey:PublicKey.default} : k) });
    assert.throws(() => assertExponentInstruction(action, owner, foreign));
    const badSigner = new TransactionInstruction({ ...ix, keys: ix.keys.map((k,i) => i===1 ? {...k,isSigner:!k.isSigner} : k) });
    assert.throws(() => assertExponentInstruction(action, owner, badSigner));
  }
});
test("u64 bounds, minima and proportional basis keep integer safety", () => {
  assert.throws(() => rawAmount("18446744073709551616"));
  assert.throws(() => rawAmount("1.5"));
  assert.equal(minimum(1n,50), 1n);
  assert.equal(exitBasis(1000001n,3n,1n) + exitBasis(666668n,2n,2n),1000001n);
});

// Transport is only for reviewed signed owner operations, not a public generic RPC.
test("broadcast rejects unsigned packets, generic CPI and extra transfers", async () => {
  const { validateMobileBroadcast } = await import("../src/lib/mobileBroadcast.server.ts");
  const { TransactionMessage, VersionedTransaction, SystemProgram } = await import("@solana/web3.js");
  const program = new PublicKey("yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih");
  const { createHash } = await import("node:crypto");
  const packet = (name, extra=false) => {
    const ix = new TransactionInstruction({programId:program,keys:[],data:createHash("sha256").update("global:"+name).digest().subarray(0,8)});
    const instructions=[ix,...(extra?[SystemProgram.transfer({fromPubkey:owner,toPubkey:program,lamports:1})]:[])];
    return new VersionedTransaction(new TransactionMessage({payerKey:owner,recentBlockhash:String(PublicKey.default),instructions}).compileToV0Message());
  };
  const unsigned=packet("deposit");
  await assert.rejects(validateMobileBroadcast({}, {programId:String(program)}, Buffer.from(unsigned.serialize())));
  for(const [name,extra] of [["execute_protocol_cpi",false],["deposit",true]]) {
    const tx=packet(name,extra);tx.signatures[0].fill(1);
    await assert.rejects(validateMobileBroadcast({}, {programId:String(program)}, Buffer.from(tx.serialize())));
  }
  const tx=packet("exponent_sell_pt");tx.signatures[0].fill(1);
  await assert.doesNotReject(validateMobileBroadcast({}, {programId:String(program)}, Buffer.from(tx.serialize())));
});
