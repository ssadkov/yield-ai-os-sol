import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { exponentOwnerAllocation } from '../src/lib/exponentOwnerAllocation.ts';
import { SAFE_PROGRAM, instructionTag, safeAddress } from '../src/lib/exponentV2.ts';
const owner = new PublicKey('CFgqVALQxKws6HtbCA4QjVDwaterCFNZzNyK3V8zV4Ls');
const executor = new PublicKey('3ayNPp7MoihfbnTQ4q6Ge5PVNe9tJsY5betKqKX7C8aH');
const decode = ix => Array.from({length:8}, (_,i) => ix.data.readUInt16LE(8+i*2));
test('new owner Safe can enable Exponent for one atomic buy and restore zero executor allocation', () => {
  const original = Array(8).fill(0);
  const result = exponentOwnerAllocation(owner, owner, 'buy', original);
  assert.equal(result.before.length,1); assert.equal(result.after.length,1);
  assert.deepEqual(decode(result.before[0]), [0,10000,0,0,0,0,0,0]);
  assert.deepEqual(decode(result.after[0]), original);
  for (const ix of [...result.before,...result.after]) {
    assert.ok(ix.programId.equals(SAFE_PROGRAM));
    assert.ok(ix.data.subarray(0,8).equals(instructionTag('set_allocation')));
    assert.equal(ix.data.length,24);
    assert.deepEqual(ix.keys.map(k=>[String(k.pubkey),k.isSigner,k.isWritable]), [[String(owner),true,false],[String(safeAddress(owner)),false,true]]);
  }
  assert.deepEqual(result.allocationBpsAfter, original);
});
test('owner buy restores mixed routes without changing the input or retaining a mutable reference', () => {
  const original = [7000,0,1000,0,0,0,0,0];
  const result = exponentOwnerAllocation(owner, owner, 'buy', original);
  assert.deepEqual(decode(result.after[0]),original);
  assert.deepEqual(original,[7000,0,1000,0,0,0,0,0]);
  original[0]=0;
  assert.deepEqual(result.allocationBpsAfter,[7000,0,1000,0,0,0,0,0]);
  assert.deepEqual(decode(result.after[0]),result.allocationBpsAfter);
});
test('executor buys never receive owner policy-changing instructions', () => {
  const result=exponentOwnerAllocation(owner,executor,'buy',Array(8).fill(0));
  assert.equal(result.before.length,0);assert.equal(result.after.length,0);
});
test('owner exits and already enabled buys leave allocation untouched', () => {
  for(const action of ['sell','redeem']) {
    const result=exponentOwnerAllocation(owner,owner,action,Array(8).fill(0));
    assert.equal(result.before.length,0);assert.equal(result.after.length,0);
  }
  const result=exponentOwnerAllocation(owner,owner,'buy',[5000,1,0,0,0,0,0,0]);
  assert.equal(result.before.length,0);assert.equal(result.after.length,0);
});
test('invalid allocations are rejected before constructing any policy instruction', () => {
  for(const original of [[],Array(9).fill(0),[-1,0,0,0,0,0,0,0],[10000,1,0,0,0,0,0,0],[0,0.5,0,0,0,0,0,0],[NaN,0,0,0,0,0,0,0]])
    assert.throws(()=>exponentOwnerAllocation(owner,owner,'buy',original));
});
