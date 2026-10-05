/** Actual upstream ELF/account fork, in-process only. Never uses a live wallet or sending RPC. */
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction, ComputeBudgetProgram, TransactionMessage } from '@solana/web3.js';
import { AnchorProvider, BorshAccountsCoder, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import { AccountLayout, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import BN from 'bn.js';
import { forkRpc } from './exponentForkRpc.js';
const sourceRequire=createRequire(import.meta.url);
const { EXPONENT, SAFE_PROGRAM, safeAddress, tokenAddress, positionAddress, decodePosition }=sourceRequire('../../web/src/lib/exponentV2.ts') as typeof import('../../web/src/lib/exponentV2.js');
const { unsignedSetup, unsignedTransaction, unsignedOnycTransfer, policyAddress }=sourceRequire('../../web/src/server/exponent/transactions.ts') as typeof import('../../web/src/server/exponent/transactions.js');

if(process.platform!=='linux')throw Error('Use Linux LiteSVM; no network sending is allowed');
const dir=process.env.EXPONENT_FORK_DIR;if(!dir)throw Error('EXPONENT_FORK_DIR required');
const testRequire=createRequire(process.env.EXPONENT_RUNTIME_PACKAGE || import.meta.url);
const runtime=testRequire('litesvm'),kit=testRequire('@solana/kit');
const snapshot=JSON.parse(readFileSync(dir+'/snapshot.json','utf8'));
const added=snapshot.accounts.map((a:{address:string;lamports:number;owner:string;executable:boolean;data:string})=>({address:new PublicKey(a.address),info:{lamports:a.lamports,owner:new PublicKey(a.owner),executable:a.executable,rentEpoch:0,data:Buffer.from(a.data,'base64')}}));
console.log('Starting actual upstream ELF LiteSVM');
const svm=new runtime.LiteSVM().withTransactionHistory(BigInt(0));
for(const p of [{name:'yield_vault',programId:SAFE_PROGRAM.toBase58()},...snapshot.programs])svm.addProgramFromFile(p.programId,dir+'/'+p.name+'.so');
const getAccount=async(key:PublicKey)=>{const a=svm.getAccount(key.toBase58());return a.exists?{lamports:Number(a.lamports),owner:new PublicKey(a.programAddress),executable:a.executable,data:Buffer.from(a.data)}:null;};
const setAccount=(key:PublicKey,a:any)=>svm.setAccount({address:key.toBase58(),lamports:BigInt(a.lamports),programAddress:a.owner.toBase58(),executable:a.executable,data:a.data,space:BigInt(a.data.length)});
for(const a of added)setAccount(a.address,a.info);
const convert=(r:any)=>{const failed=r instanceof runtime.FailedTransactionMetadata,m=failed||typeof r.meta==='function'?r.meta():r;
 return {result:failed?r.toString():null,meta:{logMessages:m.logs(),computeUnitsConsumed:m.computeUnitsConsumed()}};};
const context={payer:Keypair.generate(),setAccount,setClock:(clock:any)=>svm.setClock(clock),warpToSlot:(slot:bigint)=>svm.warpToSlot(slot),banksClient:{
 getAccount,getClock:async()=>svm.getClock(),getBlockHeight:async()=>BigInt(1),getLatestBlockhash:async()=>[svm.latestBlockhash(),BigInt(1000)] as const,
 getRent:async()=>({minimumBalance:(size:bigint)=>svm.minimumBalanceForRentExemption(size)}),
 tryProcessTransaction:async(tx:VersionedTransaction)=>convert(svm.sendTransaction(kit.getTransactionDecoder().decode(tx.serialize()))),
 simulateTransaction:async(tx:VersionedTransaction)=>{svm.withSigverify(false);try{return convert(svm.simulateTransaction(kit.getTransactionDecoder().decode(tx.serialize())));}finally{svm.withSigverify(true);}}
}};
context.setAccount(context.payer.publicKey,{lamports:30_000_000_000,owner:SystemProgram.programId,executable:false,data:Buffer.alloc(0)});
// Exact local ELF metadata fixture: exercise the same deployment capability gate.
const localElf=readFileSync(dir+'/yield_vault.so'),programData=new PublicKey('GYgDydSMpo3RbbPRgg4bA71czMM7PKQbLqWyDjWb2ukY');
const loader=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const metadata=Buffer.alloc(45+localElf.length);metadata.writeUInt32LE(3);metadata.writeBigUInt64LE(BigInt(snapshot.slot),4);localElf.copy(metadata,45);
context.setAccount(programData,{lamports:Number(svm.minimumBalanceForRentExemption(BigInt(metadata.length))),owner:loader,executable:false,data:metadata});
const programMetadata=Buffer.alloc(36);programMetadata.writeUInt32LE(2);programData.toBuffer().copy(programMetadata,4);
context.setAccount(SAFE_PROGRAM,{lamports:1000000000,owner:loader,executable:true,data:programMetadata});
console.log('LiteSVM ready; activating cloned ALTs');
context.warpToSlot(BigInt(snapshot.slot)+BigInt(1)); // Activate the cloned lookup tables.
console.log('ALTs activated');
const capturedClock=snapshot.accounts.find((a:{address:string})=>a.address==='SysvarC1ock11111111111111111111111111111111');
const clockData=Buffer.from(capturedClock.data,'base64');
const originalClock=new runtime.Clock(clockData.readBigUInt64LE(0)+BigInt(1),clockData.readBigInt64LE(8),clockData.readBigUInt64LE(16),clockData.readBigUInt64LE(24),clockData.readBigInt64LE(32));
context.setClock(originalClock);
const owner=Keypair.generate(),agent=Keypair.generate(),attacker=Keypair.generate(),treasury=context.payer.publicKey;
for(const k of [owner,agent,attacker])context.setAccount(k.publicKey,{lamports:30_000_000_000,owner:SystemProgram.programId,executable:false,data:Buffer.alloc(0)});
const server=await forkRpc(context),connection=new Connection(server.url,'confirmed');
const idl=JSON.parse(readFileSync(process.env.EXPONENT_IDL||'/tmp/exponent-build/target/idl/yield_vault.json','utf8')) as Idl;
const coder=new BorshAccountsCoder(idl),program=new Program(idl,new AnchorProvider(connection,new Wallet(owner),{commitment:'confirmed'}));
// Local administrative fixtures; production requires its existing upgrade-authority config.
const fixture=async(name:string,seed:string,data:Record<string,unknown>)=>{
 const [address,bump]=PublicKey.findProgramAddressSync([Buffer.from(seed)],SAFE_PROGRAM);
 context.setAccount(address,{lamports:1_000_000_000,owner:SAFE_PROGRAM,executable:false,data:await coder.encode(name,{...data,bump})});return address;
};
await fixture('Config','config',{admin:context.payer.publicKey,treasury,performanceFeeBps:500});
const registry=await fixture('ExecutorRegistry','executor_registry',{defaultExecutor:agent.publicKey,approved:[agent.publicKey]});
const safe=safeAddress(owner.publicKey),safeUsdc=tokenAddress(safe,EXPONENT.usdc),safeOnyc=tokenAddress(safe,EXPONENT.onyc),safePt=tokenAddress(safe,EXPONENT.pt);
const ownerUsdc=tokenAddress(owner.publicKey,EXPONENT.usdc),ownerOnyc=tokenAddress(owner.publicKey,EXPONENT.onyc),mint=new PublicKey(EXPONENT.usdc);
const usdcFixture=Buffer.alloc(165);AccountLayout.encode({mint,owner:owner.publicKey,amount:BigInt(30_000_000_000),delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:BigInt(0),delegatedAmount:BigInt(0),closeAuthorityOption:0,closeAuthority:PublicKey.default},usdcFixture);
context.setAccount(ownerUsdc,{lamports:2_039_280,owner:TOKEN_PROGRAM_ID,executable:false,data:usdcFixture});
const methods=program.methods as any;
const hash=(name:string)=>createHash('sha256').update(readFileSync(dir+'/'+name+'.so')).digest('hex');
const report:any={runtime:'LiteSVM 1.5.0',safeArtifactSha256:hash('yield_vault'),snapshot:{slot:snapshot.slot,fetchedAt:snapshot.fetchedAt},programs:snapshot.programs.map((p:any)=>({...p,sha256:hash(p.name)})),cycles:[],negative:[]};
async function send(ixs:TransactionInstructionOrV0,signer=owner) {
  const tx=Array.isArray(ixs)?new VersionedTransaction(new TransactionMessage({payerKey:signer.publicKey,recentBlockhash:(await context.banksClient.getLatestBlockhash())![0],instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000}),...ixs]}).compileToV0Message()):ixs;
  tx.sign([signer]);const r=await context.banksClient.tryProcessTransaction(tx);
  if(r.result!==null){console.log(r.meta?.logMessages.join('\n'));throw Error(r.result);}
  return Number(r.meta?.computeUnitsConsumed??0);
}
type TransactionInstructionOrV0=import('@solana/web3.js').TransactionInstruction[]|VersionedTransaction;
const balance=async(key:PublicKey)=>{const a=await context.banksClient.getAccount(key);return a?Buffer.from(a.data).readBigUInt64LE(64):BigInt(0);};
const pos=async()=>{const a=await context.banksClient.getAccount(positionAddress(safe));assert(a);return decodePosition(Buffer.from(a.data),positionAddress(safe));};
async function reject(label:string,tx:VersionedTransaction,signer:Keypair,pattern:RegExp) {
 tx.sign([signer]);const before=await balance(safeUsdc),baseBefore=await balance(safeOnyc),p=await pos();
 const r=await context.banksClient.tryProcessTransaction(tx),logs=r.meta?.logMessages.join('\n')??'';
 assert(r.result!==null,label+' must fail');assert.match(logs,pattern,label+': '+r.result);assert.equal(await balance(safeUsdc),before);
 assert.equal(await balance(safeOnyc),baseBefore);assert.equal((await pos()).trackedPt,p.trackedPt);
 report.negative.push(label);console.log('REJECT',label);
}
const limits=policyAddress('executor_limits',safe);
const setLimits=async(action:number,daily:number,principal:number,enabled=true)=>send([await methods.setExecutorLimits(new BN(action),new BN(daily),new BN(principal),enabled).accounts({owner:owner.publicKey,vault:safe,executorLimits:limits,systemProgram:SystemProgram.programId}).instruction()]);
const build=async(action:'buy'|'sell'|'redeem',amount:bigint,signer=agent,asset:'USDC'|'ONYC'='USDC')=>{
 const result=await unsignedTransaction(connection,{action,asset,amount:amount.toString(),owner:owner.publicKey.toBase58(),authority:signer.publicKey.toBase58(),slippageBps:50});
 return {tx:VersionedTransaction.deserialize(Buffer.from(result.unsignedTransaction,'base64')),result};
};
const mutate=async(tx:VersionedTransaction,change:(ix:import('@solana/web3.js').TransactionInstruction)=>void)=>{
 const tables=await Promise.all(EXPONENT.lookupTables.map(async a=>(await connection.getAddressLookupTable(new PublicKey(a))).value!));
 const message=TransactionMessage.decompile(VersionedTransaction.deserialize(tx.serialize()).message,{addressLookupTableAccounts:tables});
 const ix=message.instructions.find(i=>i.programId.equals(SAFE_PROGRAM));assert(ix);change(ix);
 return new VersionedTransaction(message.compileToV0Message(tables));
};
try {
 await send([await methods.initializeWithLimits(agent.publicKey,[0,10_000,0,0,0,0,0,0],[TOKEN_PROGRAM_ID]).accounts({owner:owner.publicKey,vault:safe,usdcMint:mint,vaultUsdcAta:safeUsdc,executorRegistry:registry,executorLimits:limits,systemProgram:SystemProgram.programId,tokenProgram:TOKEN_PROGRAM_ID}).instruction()]);
 await send([await methods.deposit(new BN(20_000_000_000)).accounts({owner:owner.publicKey,vault:safe,usdcMint:mint,ownerUsdcAta:ownerUsdc,vaultUsdcAta:safeUsdc,tokenProgram:TOKEN_PROGRAM_ID}).instruction()]);
 const setup=await unsignedSetup(connection,owner.publicKey.toBase58());await send(VersionedTransaction.deserialize(Buffer.from(setup.unsignedTransaction,'base64')));
 await setLimits(20_000_000_000,100_000_000_000,30_000_000_000);
 for(const dollars of [100,1000,10000]) {
  const before=await balance(safeUsdc),ownerBefore=await balance(ownerUsdc),buy=await build('buy',BigInt(dollars)*BigInt(1_000_000));
  assert.equal(buy.result.simulation.error,null,'buy unsigned simulation: '+buy.result.simulation.logs.join('\n'));
  const buyCu=await send(buy.tx,agent),p=await pos();assert.equal(BigInt(p.principalUsdc),BigInt(dollars)*BigInt(1_000_000));
  assert.equal(BigInt(p.trackedPt),await balance(safePt));assert(BigInt(p.entryNavWords[0])>BigInt(0));
  const half=BigInt(p.trackedPt)/BigInt(2),sell=await build('sell',half);
  const sellCu=await send(sell.tx,agent),remainder=BigInt((await pos()).trackedPt),full=await build('sell',remainder);
  await send(full.tx,agent);assert.equal((await pos()).principalUsdc,'0');assert.equal((await pos()).trackedPt,'0');
  assert.equal(await balance(safePt),BigInt(0));assert.equal(await balance(safeUsdc),before-BigInt(dollars)*BigInt(1_000_000));
  const proceeds=(await balance(ownerUsdc))-ownerBefore;
  report.cycles.push({dollars,pt:p.trackedPt,entryNavWords:p.entryNavWords,buyCu,sellCu,buyBytes:buy.result.serializedBytes,sellBytes:sell.result.serializedBytes,earlyExitUsdc:proceeds.toString(),buyQuote:buy.result.quote});
  console.log('CYCLE',dollars,'PT',p.trackedPt,'early exit USDC',proceeds.toString(),'CU',buyCu,sellCu);
 }
 // Adversarial cases operate on unsigned local messages; balance/accounting rollback is checked.
 await setLimits(50_000_000,100_000_000_000,30_000_000_000);
 await reject('executor action cap',(await build('buy',BigInt(100_000_000))).tx,agent,/ExecutorActionLimit/);
 await setLimits(20_000_000_000,100_000_000_000,30_000_000_000,false);
 await reject('executor paused',(await build('buy',BigInt(100_000_000))).tx,agent,/ExecutorPaused/);
 await setLimits(20_000_000_000,100_000_000_000,30_000_000_000);
 await reject('foreign signer',(await build('buy',BigInt(100_000_000),attacker)).tx,attacker,/Unauthorized/);
 await setLimits(50_000_000,50_000_000,30_000_000_000);
 await reject('executor daily cap',(await build('buy',BigInt(40_000_000))).tx,agent,/ExecutorVolumeLimit/);
 await setLimits(20_000_000_000,100_000_000_000,50_000_000);
 await reject('executor principal cap',(await build('buy',BigInt(100_000_000))).tx,agent,/ExecutorPositionLimit/);
 await setLimits(20_000_000_000,100_000_000_000,30_000_000_000);
 const checked=(await build('buy',BigInt(100_000_000))).tx;
 await reject('expired quote',await mutate(checked,ix=>ix.data.writeBigInt64LE(originalClock.unixTimestamp-BigInt(1),40)),agent,/Expired/);
 await reject('widened slippage',await mutate(checked,ix=>ix.data.writeBigUInt64LE(ix.data.readBigUInt64LE(32)*BigInt(98)/BigInt(100),24)),agent,/Slippage/);
 await reject('substituted market',await mutate(checked,ix=>{ix.keys[30]={...ix.keys[30],pubkey:new PublicKey(EXPONENT.coreVault)};}),agent,/InvalidAccounts/);
 await reject('substituted recipient',await mutate(checked,ix=>{ix.keys[11]={...ix.keys[11],pubkey:safeUsdc};}),agent,/ConstraintTokenOwner|ConstraintAssociated|ConstraintAddress/);
 // Bypass the off-chain checker to exercise the contract's independent dynamic ABI guard.
 const tables=await Promise.all(EXPONENT.lookupTables.map(async a=>(await connection.getAddressLookupTable(new PublicKey(a))).value!));
 const checkedMessage=TransactionMessage.decompile(checked.message,{addressLookupTableAccounts:tables});
 const safeInstruction=checkedMessage.instructions.find(i=>i.programId.equals(SAFE_PROGRAM))!;
 const tickKey=safeInstruction.keys[24].pubkey,tickAccount=await getAccount(tickKey);assert(tickAccount);
 assert.equal(tickAccount.data.subarray(0,8).toString('hex'),'11d8f68ee1c7da38','fork must exercise actual DynamicTickArray');
 for(const [label,change] of [
  ['dynamic tick foreign pool',(data:Buffer)=>PublicKey.default.toBuffer().copy(data,12)],
  ['dynamic tick wrong discriminator',(data:Buffer)=>{data[0]^=255;}],
  ['dynamic tick noncanonical start',(data:Buffer)=>{data.writeInt32LE(data.readInt32LE(8)+88,8);}],
 ] as const){
  const data=Buffer.from(tickAccount.data);change(data);context.setAccount(tickKey,{...tickAccount,data});
  try{await reject(label,checked,agent,/InvalidAccounts/);}finally{context.setAccount(tickKey,tickAccount);}
 }
 await reject('unsatisfied minimum rolls back Orca',await mutate(checked,ix=>{const high=ix.data.readBigUInt64LE(32)*BigInt(2);ix.data.writeBigUInt64LE(high,24);ix.data.writeBigUInt64LE(high,32);}),agent,/Slippage exceeded|Slippage/);
 // Native ONyc enters and leaves the same Safe without an Orca CPI. This balance is a fork-only fixture.
 const onycAccount=await context.banksClient.getAccount(ownerOnyc);assert(onycAccount);
 const onycData=Buffer.from(onycAccount.data);onycData.writeBigUInt64LE(BigInt(300_000_000_000),64);
 context.setAccount(ownerOnyc,{...onycAccount,data:onycData});
 const transfer=async(action:'deposit_onyc'|'withdraw_onyc',amount:bigint)=>{
   const t=await unsignedOnycTransfer(connection,owner.publicKey.toBase58(),action,amount.toString());
   return send(VersionedTransaction.deserialize(Buffer.from(t.unsignedTransaction,'base64')));
 };
 await transfer('deposit_onyc',BigInt(150_000_000_000));assert.equal(await balance(safeOnyc),BigInt(150_000_000_000));
  const nativeChecked=(await build('buy',BigInt(100_000_000_000),owner,'ONYC')).tx;
  await reject('native buy impossible PT minimum rolls back',await mutate(nativeChecked,ix=>{
    const high=ix.data.readBigUInt64LE(32)*BigInt(2);ix.data.writeBigUInt64LE(high,24);
  }),owner,/Slippage exceeded|Slippage/);
 const nativeBuy=await build('buy',BigInt(100_000_000_000),owner,'ONYC');await send(nativeBuy.tx,owner);
 assert.equal(await balance(safeOnyc),BigInt(50_000_000_000));
 const nativePt=BigInt((await pos()).trackedPt),nativeOwnerBefore=await balance(ownerOnyc);
  const nativeExitChecked=(await build('sell',nativePt,owner,'ONYC')).tx;
  await reject('native exit wrong ONyc recipient',await mutate(nativeExitChecked,ix=>{
    const index=ix.keys.findIndex(k=>k.pubkey.equals(ownerOnyc));assert(index>=0);ix.keys[index]={...ix.keys[index],pubkey:safeOnyc};
  }),owner,/InvalidAccounts/);
 const nativeExit=await build('sell',nativePt,owner,'ONYC');await send(nativeExit.tx,owner);
 const nativeProceeds=(await balance(ownerOnyc))-nativeOwnerBefore;
 assert.equal((await pos()).trackedPt,'0');assert.equal((await pos()).principalUsdc,'0');
 assert.equal(await balance(safeOnyc),BigInt(50_000_000_000));
 await transfer('withdraw_onyc',BigInt(50_000_000_000));assert.equal(await balance(safeOnyc),BigInt(0));
 await assert.rejects(build('buy',BigInt(1_000_000_000),agent,'ONYC'),/owner signature/);
 report.nativeOnyc={depositedRaw:'150000000000',pt:nativePt.toString(),exitToOwnerRaw:nativeProceeds.toString(),
   remainingSafeRaw:(await balance(safeOnyc)).toString(),buyBytes:nativeBuy.result.serializedBytes,exitBytes:nativeExit.result.serializedBytes};
 await transfer('deposit_onyc',BigInt(100_000_000_000));
 await send((await build('buy',BigInt(100_000_000_000),owner,'ONYC')).tx,owner);
 const matureBuy=await build('buy',BigInt(1_000_000_000));await send(matureBuy.tx,agent);
 const maturityPt=BigInt((await pos()).trackedPt),ownerBefore=await balance(ownerUsdc),ownerOnycBefore=await balance(ownerOnyc);
 const feedAddress=new PublicKey(EXPONENT.scope),feed=await context.banksClient.getAccount(feedAddress);assert(feed);
 const future=BigInt(EXPONENT.maturity+60),futureSlot=originalClock.slot+BigInt(1);
 context.setClock(new runtime.Clock(futureSlot,originalClock.epochStartTimestamp,originalClock.epoch,originalClock.leaderScheduleEpoch,future));
 // Only oracle timestamp/slot are refreshed. The fixture keeps NAV constant, not a prediction.
 const fresh=Buffer.from(feed.data),offset=40+108*56;fresh.writeBigUInt64LE(futureSlot,offset+16);fresh.writeBigUInt64LE(future,offset+24);
 context.setAccount(feedAddress,{...feed,data:fresh});
 const redeem=await build('redeem',maturityPt/BigInt(2));assert.equal(redeem.result.simulation.error,null,'PT-only maturity redemption simulation: '+redeem.result.simulation.logs.join('\n'));
 const redeemCu=await send(redeem.tx,agent);
 // Once Core freezes its rate, a later Scope update must not change the PT->ONyc quote.
 const appreciated=Buffer.from(fresh);appreciated.writeBigUInt64LE(appreciated.readBigUInt64LE(offset)*BigInt(110)/BigInt(100),offset);
 context.setAccount(feedAddress,{...feed,data:appreciated});
 const late=await build('redeem',BigInt((await pos()).trackedPt),owner,'ONYC');assert(late.result.quote.redemptionRateFrozen);
 assert.equal(late.result.simulation.error,null,'late redemption uses Core frozen rate: '+late.result.simulation.logs.join('\n'));
 const lateCu=await send(late.tx,owner);assert.equal((await pos()).trackedPt,'0');assert.equal((await pos()).principalUsdc,'0');
 assert.equal(await balance(safePt),BigInt(0));assert.equal(await balance(tokenAddress(safe,EXPONENT.yt)),BigInt(0));
 report.maturity={pt:maturityPt.toString(),usdcToOwner:((await balance(ownerUsdc))-ownerBefore).toString(),onycToOwner:((await balance(ownerOnyc))-ownerOnycBefore).toString(),redeemCu,bytes:redeem.result.serializedBytes,
   clock:future.toString(),assumption:'First half at snapshot NAV; second half after synthetic +10% Scope update, DEX pool held fixed',quote:redeem.result.quote,lateQuote:late.result.quote,lateCu};
 console.log('MATURITY',report.maturity);
 writeFileSync(process.env.EXPONENT_REPORT||dir+'/result.json',JSON.stringify(report,null,2));
 console.log('PASS actual upstream fork lifecycle; no mainnet transactions');
} finally {await server.close();}
