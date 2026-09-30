import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { createRequire } from 'node:module';
const { EXPONENT, rawAmount, minimum, exitBasis, projectedProfitFee, safeAddress, exponentAccounts, assertExponentInstruction } =
  createRequire(import.meta.url)('../../web/src/lib/exponentV2.ts') as typeof import('../../web/src/lib/exponentV2.js');

test('raw amounts reject precision loss and values outside u64',()=>{
  assert.equal(rawAmount('18446744073709551615'),(BigInt(1)<<BigInt(64))-BigInt(1));
  for(const v of [1,'0','01','1.1','1e9','-1','18446744073709551616'])assert.throws(()=>rawAmount(v));
});
test('loss and slippage floors round up; tiny positions cannot exit for zero',()=>{
  assert.equal(minimum(BigInt(1),500),BigInt(1));
  assert.equal(minimum(BigInt(10001),500),BigInt(9501));
  assert.throws(()=>minimum(BigInt(100),501));
});
test('partial exit assigns all remaining USDC basis to final exit',()=>{
  const first=exitBasis(BigInt(1000000001),BigInt(3),BigInt(1));
  assert.equal(first+exitBasis(BigInt(1000000001)-first,BigInt(2),BigInt(2)),BigInt(1000000001));
  assert.throws(()=>exitBasis(BigInt(10),BigInt(2),BigInt(3)));
});
test('future 5% is charged on positive USDC profit only',()=>{
  assert.equal(projectedProfitFee(BigInt(1000),BigInt(1100)),BigInt(5));
  assert.equal(projectedProfitFee(BigInt(1000),BigInt(950)),BigInt(0));
});
test('SDK account substitution and unexpected signer privileges fail closed',()=>{
  const safe=safeAddress(PublicKey.default);
  for(const action of ['buy','sell','redeem'] as const) {
    const t=EXPONENT.actions[action],keys=exponentAccounts(action,safe).slice(1).map((k,i)=>({...k,isSigner:t.accounts[i].signer}));
    const data=Buffer.alloc(action==='redeem'?10:19);data[0]=parseInt(t.discriminator,16);data[data.length-1]=10;
    const ix=new TransactionInstruction({programId:new PublicKey(t.program),keys,data});assertExponentInstruction(action,safe,ix);
    const original=ix.keys[0];ix.keys[0]={...original,pubkey:PublicKey.default};assert.throws(()=>assertExponentInstruction(action,safe,ix));
    ix.keys[0]=original;ix.keys[1]={...ix.keys[1],isSigner:!ix.keys[1].isSigner};assert.throws(()=>assertExponentInstruction(action,safe,ix));
  }
});
