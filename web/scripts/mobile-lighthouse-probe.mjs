import assert from 'node:assert/strict';
import { Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

// Read-only Mainnet probe. No signer, private key, sendTransaction or /rpc broadcast.
const rpc = process.env.V2_MAINNET_RPC_URL;
if (!rpc) throw new Error('Set server-side V2_MAINNET_RPC_URL without logging it');
const owner = process.env.LIGHTHOUSE_PROBE_OWNER ?? '4qMokYU7riMKgtG7zf4S22oFimcooAfPXySSc4XWMgkE';
const base = process.env.LIGHTHOUSE_PROBE_API ?? 'https://yield-ai-solana-mainnet.vercel.app/api/mobile/v1';
const connection = new Connection(rpc, 'confirmed');
assert.equal(await connection.getGenesisHash(), '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
const response = await fetch(`${base}/protocols/kamino/deposits/plan`, {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({cluster:'mainnet',owner:{type:'solana',address:owner},source:'wallet',amount:'1'}),
});
const plan = await response.json();
assert.equal(response.status,200);assert.equal(plan.status,'ready');
const original = VersionedTransaction.deserialize(Buffer.from(plan.steps[0].transaction,'base64'));
const tables = await Promise.all(original.message.addressTableLookups.map(async l => {
  const {value}=await connection.getAddressLookupTable(l.accountKey);assert.ok(value);return value;
}));
const message = TransactionMessage.decompile(original.message,{addressLookupTableAccounts:tables});
const lighthouse = new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');
const target = new PublicKey(plan.sourceAccount);
const mint = new PublicKey(plan.state.network.usdcMint);
const balance = BigInt((await connection.getTokenAccountBalance(target)).value.amount);
const expectedBalance = balance-BigInt(plan.amountRaw);
function guard(data, account=target) {
  return new TransactionInstruction({programId:lighthouse,keys:[{pubkey:account,isSigner:false,isWritable:false}],data});
}
const u64 = n => {const b=Buffer.alloc(8);b.writeBigUInt64LE(n);return b;};
// Borsh assertion enums: token Mint=0, Amount=2; integer/equatable Equal=0.
const tokenMint=guard(Buffer.concat([Buffer.from([9,4,0]),mint.toBuffer(),Buffer.from([0])]));
const mintDecimals=guard(Buffer.from([7,4,2,6,0]),mint);
const multi=amount=>guard(Buffer.concat([Buffer.from([10,5,2,0]),mint.toBuffer(),Buffer.from([0,2]),u64(amount),Buffer.from([0])]));
for(const [name,post,shouldPass] of [['token-and-mint',multi(expectedBalance),true],['false-token-balance',multi(expectedBalance+BigInt(1)),false]]) {
  const instructions=[tokenMint,mintDecimals,...message.instructions,post];
  const tx=new VersionedTransaction(new TransactionMessage({payerKey:message.payerKey,recentBlockhash:message.recentBlockhash,instructions}).compileToV0Message(tables));
  assert.ok(tx.signatures.every(s=>s.every(b=>b===0)));
  const bytes=tx.serialize().length;assert.ok(bytes<=1232);
  const result=await connection.simulateTransaction(tx,{sigVerify:false,replaceRecentBlockhash:true,commitment:'confirmed'});
  console.log(JSON.stringify({name,owner,planId:plan.planId,bytes,slot:result.context.slot,unitsConsumed:result.value.unitsConsumed,error:result.value.err,lighthouseLogs:result.value.logs?.filter(x=>x.includes(lighthouse.toBase58())||x.includes('Error')||x.includes('failed'))}));
  if(shouldPass) assert.equal(result.value.err,null);
  else {assert.ok(result.value.err);assert.ok(result.value.logs?.some(x=>x.startsWith(`Program ${lighthouse} failed`)));}
}
