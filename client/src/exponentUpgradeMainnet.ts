/** Approved 2026-10-05 Mainnet upgrade only. No user asset instructions or new private keys. */
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { utils } from '@coral-xyz/anchor';
import { Connection, PublicKey, Keypair, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';

const HASH='48da204eea62b79db16474045a2ede6e139c54e4d1023f99b09dfc3adfe7565d';
const OLD_HASH='9543eb14e69694d25d6a4d1bba2a5bcc7f00f1d34a095112d0b898764805269f';
const OLD_BYTES=686960, ELF_BYTES=690944, PD_BYTES=697245, BUFFER_BYTES=690981;
const FEE_CAP=10000000, RENT_INCREMENT=52019200, BUFFER_RENT=3510833720;
const payer=new PublicKey('8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A');
const program=new PublicKey('yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih');
const pd=new PublicKey('GYgDydSMpo3RbbPRgg4bA71czMM7PKQbLqWyDjWb2ukY');
const loader=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const seed='yield-onyc-dyn-20261005';
const buffer=await PublicKey.createWithSeed(payer,seed,loader);
assert.equal(buffer.toBase58(),'HhQJ1ecMoG5fa5xXgjRQyaxxmxsJtzLj3jxfPUVf8NAK');
const stage=process.argv[2]??'inspect';assert(['inspect','prepare','upload','simulate-upgrade','upgrade','verify'].includes(stage));
const elf=readFileSync(process.env.EXPONENT_UPGRADE_ELF??'/tmp/onyc-dynamic-build-20261005/target/deploy/yield_vault.so');
const digest=(d:Buffer)=>createHash('sha256').update(d).digest('hex');
assert.equal(elf.length,ELF_BYTES);assert.equal(digest(elf),HASH);
const c=new Connection(process.env.EXPONENT_UPGRADE_RPC_URL??'https://solana-rpc.publicnode.com',{commitment:'confirmed',confirmTransactionInitialTimeout:60000,
 fetch:(url,o)=>fetch(url,{...o,signal:AbortSignal.timeout(30000)})});
assert.equal(await c.getGenesisHash(),'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
const journalPath=process.env.EXPONENT_UPGRADE_JOURNAL??'/tmp/onyc-dynamic-upgrade-20261005.json';
type Entry={label:string;signature:string;wire:string;blockhash:string;lastValidBlockHeight:number;fee:number;confirmed?:boolean;dropped?:boolean};
type Journal={hash:string;program:string;payer:string;buffer:string;baselineBalance:number;baselinePdLamports:number;reservedFees:number;transactions:Entry[];completed?:Record<string,unknown>};
const journal:Journal=existsSync(journalPath)?JSON.parse(readFileSync(journalPath,'utf8')):{hash:HASH,program:program.toBase58(),payer:payer.toBase58(),buffer:buffer.toBase58(),baselineBalance:await c.getBalance(payer),baselinePdLamports:(await c.getAccountInfo(pd))!.lamports,reservedFees:0,transactions:[]};
assert.equal(journal.hash,HASH);assert.equal(journal.program,program.toBase58());assert.equal(journal.payer,payer.toBase58());assert.equal(journal.buffer,buffer.toBase58());
assert(Number.isSafeInteger(journal.reservedFees)&&journal.reservedFees>=0&&journal.reservedFees<=FEE_CAP);
assert.equal(journal.baselinePdLamports,3490635640);
const persist=()=>writeFileSync(journalPath,JSON.stringify(journal,null,2),{mode:0o600});
const meta=(pubkey:PublicKey,isWritable=false,isSigner=false)=>({pubkey,isWritable,isSigner});
function checkedPd(a:Awaited<ReturnType<Connection['getAccountInfo']>>) {
 assert(a&&!a.executable&&a.owner.equals(loader)&&a.data.length>=45+OLD_BYTES);
 assert.equal(a.data.readUInt32LE(0),3);assert.equal(a.data[12],1);assert(new PublicKey(a.data.subarray(13,45)).equals(payer));return a;
}
function checkedBuffer(a:Awaited<ReturnType<Connection['getAccountInfo']>>) {
 assert(a&&!a.executable&&a.owner.equals(loader)&&a.data.length===BUFFER_BYTES&&a.lamports===BUFFER_RENT);
 assert.equal(a.data.readUInt32LE(0),1);assert.equal(a.data[4],1);assert(new PublicKey(a.data.subarray(5,37)).equals(payer));return a;
}
const [programInfo,pdInfo]=await c.getMultipleAccountsInfo([program,pd]);
assert(programInfo?.executable&&programInfo.owner.equals(loader)&&programInfo.data.length===36&&programInfo.data.readUInt32LE(0)===2);
assert(new PublicKey(programInfo.data.subarray(4,36)).equals(pd));checkedPd(pdInfo);
const deployed=digest(pdInfo!.data.subarray(45,45+ELF_BYTES))===HASH;
assert(deployed||digest(pdInfo!.data.subarray(45,45+OLD_BYTES))===OLD_HASH,'Unexpected deployed ELF; stop');
assert.equal(await c.getMinimumBalanceForRentExemption(PD_BYTES),3542654840);
assert.equal(await c.getMinimumBalanceForRentExemption(BUFFER_BYTES),BUFFER_RENT);
if(['prepare','upload','upgrade'].includes(stage))assert.equal(process.env.EXPONENT_UPGRADE_APPROVED_SHA256,HASH,'Explicit approved hash required');
let signer:Keypair|null=null;
function approvedSigner(){if(!signer){assert(process.env.EXPONENT_DEPLOYER_KEYPAIR,'Existing operator key path required');signer=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.EXPONENT_DEPLOYER_KEYPAIR,'utf8'))));assert(signer.publicKey.equals(payer));}return signer;}
async function reconcile(entry:Entry) {
 let status=(await c.getSignatureStatuses([entry.signature],{searchTransactionHistory:true})).value[0];
 if(status?.err)throw Error('Confirmed transaction failed: '+entry.signature+' '+JSON.stringify(status.err));
 if(status&&(status.confirmationStatus==='confirmed'||status.confirmationStatus==='finalized')){entry.confirmed=true;persist();return;}
 if(await c.getBlockHeight()>entry.lastValidBlockHeight){
  status=(await c.getSignatureStatuses([entry.signature],{searchTransactionHistory:true})).value[0];
  if(status&&(status.confirmationStatus==='confirmed'||status.confirmationStatus==='finalized')){assert.equal(status.err,null);entry.confirmed=true;}else if(!status)entry.dropped=true;else throw Error('Receipt still processed; wait and reconcile, never replace');
  persist();return;
 }
 const wire=Buffer.from(entry.wire,'base64');
 await broadcast(entry);
 await waitConfirmed(entry);
}
// Pending signatures are reconciled, never silently replaced after a timeout.
if(['prepare','upload','upgrade'].includes(stage))for(const entry of journal.transactions.filter(t=>!t.confirmed&&!t.dropped))await reconcile(entry);
async function broadcast(entry:Entry) {
 try{assert.equal(await c.sendRawTransaction(Buffer.from(entry.wire,'base64'),{skipPreflight:false,maxRetries:20}),entry.signature);}
 catch(e){if(!(e instanceof Error)||!e.message.includes('already been processed'))throw e;}
 // A duplicate preflight response is not a receipt: still wait for confirmed status.
}
async function waitConfirmed(entry:Entry) {
 const started=Date.now();let polls=0;
 while(Date.now()-started<60000){
  await new Promise(resolve=>setTimeout(resolve,400));
  const status=(await c.getSignatureStatuses([entry.signature])).value[0];
  if(status?.err)throw Error('Transaction failed: '+entry.signature+' '+JSON.stringify(status.err));
  if(status&&(status.confirmationStatus==='confirmed'||status.confirmationStatus==='finalized')){entry.confirmed=true;persist();return;}
  if(++polls%8===0){
   if((await c.getBlockHeight('confirmed'))>entry.lastValidBlockHeight)throw Error('Expiry: reconcile saved signature before replacing it');
   await broadcast(entry);
  }
 }
 throw Error('Confirmation timeout: reconcile saved signature before replacing it');
}
let cachedBh:{blockhash:string;lastValidBlockHeight:number;fetchedAt:number}|null=null;
const feeCache=new Map<string,number>();
async function simulation(ixs:TransactionInstruction[]) {
 if(!cachedBh||Date.now()-cachedBh.fetchedAt>15000){
  const slot=await c.getSlot('confirmed'),fresh=await c.getLatestBlockhash({commitment:'confirmed',minContextSlot:slot});
  assert(fresh.lastValidBlockHeight-(await c.getBlockHeight('confirmed'))>=75,'RPC supplied a stale blockhash; no new signature');
  cachedBh={...fresh,fetchedAt:Date.now()};
 }
 const bh={blockhash:cachedBh.blockhash,lastValidBlockHeight:cachedBh.lastValidBlockHeight};
 const m=new TransactionMessage({payerKey:payer,recentBlockhash:bh.blockhash,instructions:ixs}).compileToV0Message(),tx=new VersionedTransaction(m);
 assert(tx.serialize().length<=1232);const sim=await c.simulateTransaction(tx,{sigVerify:false});
 assert.equal(sim.value.err,null,JSON.stringify({error:sim.value.err,logs:sim.value.logs}));
 const feeKey=bh.blockhash+':'+ixs.filter(i=>i.programId.equals(ComputeBudgetProgram.programId)).map(i=>i.data.toString('hex')).join(':');
 const fee=feeCache.get(feeKey)??(await c.getFeeForMessage(m)).value;assert(fee!==null&&fee>0&&fee<=10000);feeCache.set(feeKey,fee);assert(Date.now()-cachedBh.fetchedAt<20000,'Slow RPC: refresh before signing');
 return {bh,tx,fee,units:sim.value.unitsConsumed};
}
async function send(label:string,ixs:TransactionInstruction[]) {
 const {bh,tx,fee,units}=await simulation(ixs);assert(journal.reservedFees+fee<=FEE_CAP,'Network fee cap exceeded');
 tx.sign([approvedSigner()]);
 const wire=tx.serialize(),signature=utils.bytes.bs58.encode(tx.signatures[0]);
 const entry:Entry={label,signature,wire:Buffer.from(wire).toString('base64'),...bh,fee};
 journal.reservedFees+=fee;journal.transactions.push(entry);persist();
 await broadcast(entry);
 await waitConfirmed(entry);assert(entry.confirmed,'Reconcile state before replacing a signature');
 if(label!=='write')console.log(JSON.stringify({label,signature,units,fee,reservedFees:journal.reservedFees}));
}
function preparation() {
 const data=Buffer.alloc(8);data.writeUInt32LE(6);data.writeUInt32LE(10240,4);
 return [new TransactionInstruction({programId:loader,keys:[meta(pd,true),meta(program,true),meta(SystemProgram.programId),meta(payer,true,true)],data}),
 SystemProgram.createAccountWithSeed({fromPubkey:payer,newAccountPubkey:buffer,basePubkey:payer,seed,lamports:BUFFER_RENT,space:BUFFER_BYTES,programId:loader}),
 new TransactionInstruction({programId:loader,keys:[meta(buffer,true),meta(payer)],data:Buffer.alloc(4)})];
}
function upgrade() {
 const data=Buffer.alloc(4);data.writeUInt32LE(3);
 return [ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),new TransactionInstruction({programId:loader,
 keys:[meta(pd,true),meta(program,true),meta(buffer,true),meta(payer,true),meta(SYSVAR_RENT_PUBKEY),meta(SYSVAR_CLOCK_PUBKEY),meta(payer,false,true)],data})];
}
if(stage==='inspect'){
 const balance=await c.getBalance(payer),buf=await c.getAccountInfo(buffer);
 console.log(JSON.stringify({stage,hash:HASH,program:program.toBase58(),deployer:payer.toBase58(),balance,programDataBytes:pdInfo!.data.length,buffer:buffer.toBase58(),bufferExists:!!buf,deployed,feeCap:FEE_CAP}));
 if(!buf&&!deployed){assert(balance>=RENT_INCREMENT+BUFFER_RENT+FEE_CAP);const sim=await simulation(preparation());console.log(JSON.stringify({unsigned:true,preparationUnits:sim.units,fee:sim.fee}));}
}
if(stage==='prepare'){
 assert(!deployed);const buf=await c.getAccountInfo(buffer);
 if(buf){checkedBuffer(buf);assert.equal(pdInfo!.data.length,PD_BYTES);console.log('Preparation already confirmed; no new transfer');}
 else{assert.equal(pdInfo!.data.length,687005);assert(await c.getBalance(payer)>=RENT_INCREMENT+BUFFER_RENT+FEE_CAP);await send('prepare',preparation());checkedBuffer(await c.getAccountInfo(buffer));assert.equal(checkedPd(await c.getAccountInfo(pd)).data.length,PD_BYTES);}
}
if(stage==='upload'){
 assert(!deployed);assert.equal(pdInfo!.data.length,PD_BYTES);const buf=checkedBuffer(await c.getAccountInfo(buffer));
 let count=0;const missing:number[]=[];for(let offset=0;offset<elf.length;offset+=900)if(!elf.subarray(offset,offset+900).equals(buf.data.subarray(37+offset,37+Math.min(offset+900,elf.length))))missing.push(offset);
 assert(journal.reservedFees+missing.length*5500+10000<=FEE_CAP,'Upload cannot fit remaining fee cap');
 console.log(JSON.stringify({stage,missingChunks:missing.length,totalBytes:elf.length}));
 for(const offset of missing){const chunk=elf.subarray(offset,offset+900),data=Buffer.alloc(16+chunk.length);data.writeUInt32LE(1);data.writeUInt32LE(offset,4);data.writeBigUInt64LE(BigInt(chunk.length),8);chunk.copy(data,16);
  await send('write',[ComputeBudgetProgram.setComputeUnitLimit({units:25000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:20000}),new TransactionInstruction({programId:loader,keys:[meta(buffer,true),meta(payer,false,true)],data})]);
  count++;if(count%25===0||count===missing.length)console.log(JSON.stringify({uploadedChunks:count,remainingChunks:missing.length-count,reservedFees:journal.reservedFees}));
 }
 const complete=checkedBuffer(await c.getAccountInfo(buffer));assert.equal(digest(complete.data.subarray(37)),HASH);console.log(JSON.stringify({bufferVerified:true,hash:HASH,reservedFees:journal.reservedFees}));
}
if(stage==='simulate-upgrade'||stage==='upgrade'){
 assert(!deployed);assert.equal(pdInfo!.data.length,PD_BYTES);const buf=checkedBuffer(await c.getAccountInfo(buffer));assert.equal(digest(buf.data.subarray(37)),HASH);
 if(stage==='simulate-upgrade'){const sim=await simulation(upgrade());console.log(JSON.stringify({unsigned:true,upgradeSimulation:'ok',units:sim.units,fee:sim.fee,hash:HASH}));}
 else await send('upgrade',upgrade());
}
if(stage==='verify'||stage==='upgrade'){
 const final=checkedPd(await c.getAccountInfo(pd));assert.equal(digest(final.data.subarray(45,45+ELF_BYTES)),HASH);assert.equal(final.data.length,PD_BYTES);
 assert.equal(await c.getAccountInfo(buffer),null,'Upload buffer must be closed');const balance=await c.getBalance(payer),debit=journal.baselineBalance-balance;
 assert(debit>=RENT_INCREMENT&&debit<=RENT_INCREMENT+FEE_CAP);assert.equal(final.lamports-journal.baselinePdLamports,RENT_INCREMENT);
 const actualFees=debit-RENT_INCREMENT;assert(actualFees<=journal.reservedFees);
 journal.completed={hash:HASH,slot:final.data.readBigUInt64LE(4).toString(),balance,debit,permanentRent:RENT_INCREMENT,actualFees,bufferClosed:true,authority:payer.toBase58()};persist();console.log(JSON.stringify(journal.completed));
}
