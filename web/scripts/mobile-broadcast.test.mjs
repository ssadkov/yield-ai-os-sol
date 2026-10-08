import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, SendTransactionError, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { validateMobileBroadcast, submitMobileBroadcast, LIGHTHOUSE_PROGRAM, MAX_PRIORITY_FEE_LAMPORTS } from '../src/lib/mobileBroadcast.server.ts';
import { MOBILE_NETWORKS, safeAddresses } from '../src/lib/mobileSafe.ts';

// Local, deterministic test signer only. Nothing from these fixtures is sent to a real RPC.
const owner = Keypair.fromSeed(new Uint8Array(32).fill(19));
const foreign = Keypair.fromSeed(new Uint8Array(32).fill(20));
const network = MOBILE_NETWORKS.mainnet;
const a = safeAddresses(owner.publicKey, network);
const recentBlockhash = foreign.publicKey.toBase58();
const tag = name => createHash('sha256').update('global:' + name).digest().subarray(0,8);
const safe = (name = 'deposit', authority = owner.publicKey) => new TransactionInstruction({
  programId: a.program, keys: [{pubkey: authority, isSigner:true, isWritable:true}, {pubkey:a.safe, isSigner:false, isWritable:true}],
  data: Buffer.concat([tag(name), Buffer.alloc(8,1)]),
});
const guard = (level = 4, target = owner.publicKey) => new TransactionInstruction({programId:LIGHTHOUSE_PROGRAM,
  keys:[{pubkey:target,isSigner:false,isWritable:false}], data:Buffer.from([6,level,1,5,1,0])});
function signed(instructions, tables = [], signers = [owner]) {
  const tx = new VersionedTransaction(new TransactionMessage({payerKey:owner.publicKey,recentBlockhash,instructions}).compileToV0Message(tables));
  tx.sign(signers);
  return Buffer.from(tx.serialize());
}
const noTables = {getAddressLookupTable:async()=>{throw Error('unexpected table read');}};
const rejects = wire => assert.rejects(()=>validateMobileBroadcast(noTables,network,wire),e=>e.code==='INVALID_TRANSACTION' && e.status===400);

test('Seed Vault original signed owner transaction still passes',async()=>{
  await validateMobileBroadcast(noTables,network,signed([ComputeBudgetProgram.setComputeUnitLimit({units:300000}),safe()]));
});
test('Phantom guards before/after Safe and 375000 priority price pass with protected Safe instruction unchanged',async()=>{
  const original = safe();
  const wire = signed([guard(4),ComputeBudgetProgram.setComputeUnitPrice({microLamports:375000}),original,guard(4,a.safe)]);
  await validateMobileBroadcast(noTables,network,wire);
  const decoded = TransactionMessage.decompile(VersionedTransaction.deserialize(wire).message).instructions.find(ix=>ix.programId.equals(a.program));
  assert.deepEqual(decoded.data,original.data);
  assert.deepEqual(decoded.keys,original.keys);
});
test('Solflare compute price after Safe and 06 05 guard pass',async()=>{
  await validateMobileBroadcast(noTables,network,signed([ComputeBudgetProgram.setComputeUnitLimit({units:400000}),safe('initialize_with_limits'),ComputeBudgetProgram.setComputeUnitPrice({microLamports:100000}),guard(5)]));
});
test('Owner create, deposit, withdraw, Kamino and Exponent reviewed operations remain allowed',async()=>{
  for (const name of ['initialize_with_limits','deposit','withdraw','set_allocation','kamino_deposit','kamino_withdraw','init_exponent_position','exponent_buy_pt','exponent_sell_pt','exponent_redeem_pt'])
    await validateMobileBroadcast(noTables,network,signed([safe(name),guard(4)]));
});
test('ATA creation remains compatible with appended Lighthouse',async()=>{
  const ata = getAssociatedTokenAddressSync(a.mint,owner.publicKey);
  const ix = createAssociatedTokenAccountIdempotentInstruction(owner.publicKey,ata,owner.publicKey,a.mint);
  await validateMobileBroadcast(noTables,network,signed([ix,safe(),guard(5)]));
});
test('Lighthouse target can come from an active address lookup table',async()=>{
  const table = new AddressLookupTableAccount({key:foreign.publicKey,state:{deactivationSlot:(1n<<64n)-1n,lastExtendedSlot:1,lastExtendedSlotStartIndex:0,authority:undefined,addresses:[a.safe]}});
  const wire=signed([safe(),guard(5,a.safe)],[table]);
  assert.equal(VersionedTransaction.deserialize(wire).message.addressTableLookups.length,1);
  await validateMobileBroadcast({getAddressLookupTable:async()=>({value:table})},network,wire);
  await assert.rejects(()=>validateMobileBroadcast({getAddressLookupTable:async()=>({value:null})},network,wire),e=>e.code==='INVALID_TRANSACTION');
});
test('Reject foreign program, System transfer, unknown Safe action and Lighthouse-only payload',async()=>{
  await rejects(signed([safe(),SystemProgram.transfer({fromPubkey:owner.publicKey,toPubkey:foreign.publicKey,lamports:1})]));
  await rejects(signed([safe(),new TransactionInstruction({programId:foreign.publicKey,keys:[],data:Buffer.from([6,4,1])})]));
  await rejects(signed([safe('execute_protocol_cpi'),guard()]));
  await rejects(signed([guard()]));
});
test('Reject Lighthouse memory commands and every unreviewed discriminator',async()=>{
  for (const discriminator of [0,1,...Array.from({length:238},(_,i)=>i+18)]) {
    const ix=guard();ix.data[0]=discriminator;
    await rejects(signed([safe(),ix]));
  }
});
test('Reject malformed Lighthouse data or extra/missing target accounts',async()=>{
  for(const data of [Buffer.alloc(0),Buffer.from([6]),Buffer.from([6,4])]) {const ix=guard();ix.data=data;await rejects(signed([safe(),ix]));}
  for(const count of [0,2]) {const ix=guard();ix.keys=count ? [...ix.keys,{pubkey:a.safe,isSigner:false,isWritable:false}] : [];await rejects(signed([safe(),ix]));}
});
test('Budget accepts observed prices and rejects excessive totals/unknown/malformed instructions',async()=>{
  await validateMobileBroadcast(noTables,network,signed([safe(),ComputeBudgetProgram.setComputeUnitPrice({microLamports:500000}),guard()]));
  await rejects(signed([safe(),ComputeBudgetProgram.setComputeUnitPrice({microLamports:1000000})]));
  await rejects(signed([safe(),ComputeBudgetProgram.setComputeUnitLimit({units:1400001})]));
  for(const data of [Buffer.from([0,1,2,3,4]),Buffer.from([3,1]),Buffer.from([2]),Buffer.from([255])]) {
    await rejects(signed([safe(),new TransactionInstruction({programId:ComputeBudgetProgram.programId,keys:[],data})]));
  }
});
test('High wallet CU price passes when requested total priority fee stays within 0.001 SOL',async()=>{
  for (const trailingPrice of [false,true]) {
    const limit=ComputeBudgetProgram.setComputeUnitLimit({units:300000});
    const price=ComputeBudgetProgram.setComputeUnitPrice({microLamports:3000000});
    const ixs=trailingPrice ? [limit,safe(),price,guard(5)] : [price,guard(4),safe(),limit];
    await validateMobileBroadcast(noTables,network,signed(ixs));
  }
});
test('Total fee cap uses exact round-up and exposes precise safe diagnostics at the boundary',async()=>{
  const wire=price=>signed([safe(),ComputeBudgetProgram.setComputeUnitPrice({microLamports:price}),ComputeBudgetProgram.setComputeUnitLimit({units:300000}),guard()]);
  await validateMobileBroadcast(noTables,network,wire(3333333n)); // ceil(999999.9) = 1000000.
  await assert.rejects(()=>validateMobileBroadcast(noTables,network,wire(3333334n)),e=>{
    assert.equal(e.code,'INVALID_TRANSACTION');assert.equal(e.status,400);
    assert.deepEqual(e.details,{priorityFeeLamports:'1000001',maxPriorityFeeLamports:String(MAX_PRIORITY_FEE_LAMPORTS),computeUnitPriceMicroLamports:'3333334',computeUnitLimit:'300000',conservativeLimit:false});
    return true;
  });
  await rejects(wire((1n<<64n)-1n));
});
test('Missing CU limit uses conservative 1.4M bound; zero price needs no limit',async()=>{
  await validateMobileBroadcast(noTables,network,signed([safe(),ComputeBudgetProgram.setComputeUnitPrice({microLamports:0})]));
  await validateMobileBroadcast(noTables,network,signed([safe(),ComputeBudgetProgram.setComputeUnitPrice({microLamports:714285})]));
  await assert.rejects(()=>validateMobileBroadcast(noTables,network,signed([safe(),ComputeBudgetProgram.setComputeUnitPrice({microLamports:714286})])),e=>e.code==='INVALID_TRANSACTION'&&e.details.conservativeLimit&&e.details.priorityFeeLamports==='1000001');
});
test('Duplicate budgets cannot select a cheaper limit/price to bypass the fee ceiling',async()=>{
  for (const variants of [
    [ComputeBudgetProgram.setComputeUnitPrice({microLamports:30000000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:1})],
    [ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),ComputeBudgetProgram.setComputeUnitLimit({units:1})],
    [ComputeBudgetProgram.requestHeapFrame({bytes:32768}),ComputeBudgetProgram.requestHeapFrame({bytes:32768})],
  ]) await assert.rejects(()=>validateMobileBroadcast(noTables,network,signed([variants[0],safe(),variants[1],guard()])),e=>e.code==='INVALID_TRANSACTION'&&e.message==='Duplicate compute budget instruction');
});
test('Reject invalid, absent, or stale owner signature after message tampering',async()=>{
  const wire=signed([safe(),guard()]);
  const tx=VersionedTransaction.deserialize(wire);tx.signatures[0][0]^=1;await rejects(Buffer.from(tx.serialize()));
  tx.signatures[0].fill(0);await rejects(Buffer.from(tx.serialize()));
  const changed=VersionedTransaction.deserialize(wire);changed.message.recentBlockhash=owner.publicKey.toBase58();await rejects(Buffer.from(changed.serialize()));
});
test('Reject legacy, extra signer, owner/payer mismatch, malformed and oversized wire',async()=>{
  const legacy=new Transaction({feePayer:owner.publicKey,recentBlockhash}).add(safe());legacy.sign(owner);await rejects(legacy.serialize());
  await rejects(signed([safe('deposit',foreign.publicKey) ],[],[owner,foreign]));
  const unsignedAuthority = safe();unsignedAuthority.keys[0]={pubkey:foreign.publicKey,isSigner:false,isWritable:false};await rejects(signed([unsignedAuthority]));
  await rejects(Buffer.from([0,1,2]));await rejects(Buffer.alloc(1233));
});
test('Submission sends exactly the validated wire once with compulsory preflight',async()=>{
  const wire=signed([safe(),guard(5)]);let calls=0;
  const connection={...noTables,sendRawTransaction:async(actual,options)=>{calls++;assert.deepEqual(actual,wire);assert.deepEqual(options,{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:2});return 'test-signature';}};
  assert.equal(await submitMobileBroadcast(connection,network,wire),'test-signature');assert.equal(calls,1);
  await assert.rejects(()=>submitMobileBroadcast(connection,network,signed([safe(),SystemProgram.transfer({fromPubkey:owner.publicKey,toPubkey:foreign.publicKey,lamports:1})])),e=>e.code==='INVALID_TRANSACTION');assert.equal(calls,1);
});
test('Explicit RPC preflight rejection is sanitized 422; unknown send failure stays unknown and is not retried',async()=>{
  const wire=signed([safe(),guard()]);let calls=0;
  const connection={...noTables,sendRawTransaction:async()=>{calls++;throw new SendTransactionError({action:'simulate',signature:'',transactionMessage:'private RPC URL must not leak',logs:[]});}};
  await assert.rejects(()=>submitMobileBroadcast(connection,network,wire),e=>e.code==='SIMULATION_FAILED' && e.status===422 && !e.message.includes('private'));assert.equal(calls,1);
  const unknown=Error('timeout after send');connection.sendRawTransaction=async()=>{calls++;throw unknown;};
  await assert.rejects(()=>submitMobileBroadcast(connection,network,wire),e=>e===unknown);assert.equal(calls,2);
});

// These are transport shape fixtures; mandatory on-chain preflight owns full payload decoding.
const compression = new PublicKey('cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK');
function assertion(tag) {
  const ix=guard();ix.data[0]=tag;
  if(tag===4) ix.keys.push({pubkey:a.safe,isSigner:false,isWritable:false});
  if(tag===15) ix.keys=[];
  if(tag===16) ix.keys.push({pubkey:a.safe,isSigner:false,isWritable:false},{pubkey:compression,isSigner:false,isWritable:false},{pubkey:foreign.publicKey,isSigner:false,isWritable:false});
  return ix;
}
test('All reviewed Lighthouse assertion families 2..17 pass transport shape validation',async()=>{
  for(let tag=2;tag<=17;tag++) await validateMobileBroadcast(noTables,network,signed([assertion(tag),safe(),assertion(tag)]));
});
test('Phantom/Solflare token and mint assertions accompany owner deposit and withdrawal',async()=>{
  for(const operation of ['deposit','kamino_deposit','kamino_withdraw','withdraw','exponent_buy_pt','exponent_sell_pt'])
    for(const level of [4,5]) {
      const token=assertion(10);token.data[1]=level;
      await validateMobileBroadcast(noTables,network,signed([guard(level),assertion(7),safe(operation),ComputeBudgetProgram.setComputeUnitPrice({microLamports:100000}),token,assertion(9)]));
    }
});
test('Token assertions retain support for writable targets resolved through an active LUT',async()=>{
  const table=new AddressLookupTableAccount({key:foreign.publicKey,state:{deactivationSlot:(1n<<64n)-1n,lastExtendedSlot:1,lastExtendedSlotStartIndex:0,authority:undefined,addresses:[a.safe]}});
  const token=assertion(10);token.keys[0].pubkey=a.safe;
  const wire=signed([safe(),token],[table]);
  assert.equal(VersionedTransaction.deserialize(wire).message.addressTableLookups.length,1);
  await validateMobileBroadcast({getAddressLookupTable:async()=>({value:table})},network,wire);
});
test('Reject malformed delta/clock/Merkle shapes and foreign Merkle CPI program',async()=>{
  for(const tag of [4,15,16]) {
    const ix=assertion(tag);ix.keys=tag===15 ? guard().keys : [];
    await rejects(signed([safe(),ix]));
  }
  const merkle=assertion(16);merkle.keys[2].pubkey=foreign.publicKey;
  await rejects(signed([safe(),merkle]));
});
test('Malformed assertion bodies reach compulsory preflight, whose rejection remains not submitted',async()=>{
  const wire=signed([safe(),assertion(10)]);let calls=0;
  await assert.rejects(()=>submitMobileBroadcast({...noTables,sendRawTransaction:async(actual,options)=>{
    calls++;assert.deepEqual(actual,wire);assert.equal(options.skipPreflight,false);
    throw new SendTransactionError({action:'simulate',signature:'',transactionMessage:'InvalidInstructionData',logs:[]});
  }},network,wire),e=>e.code==='SIMULATION_FAILED'&&e.status===422);
  assert.equal(calls,1);
});
