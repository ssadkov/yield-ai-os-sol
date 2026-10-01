import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { PublicKey, Keypair, Transaction, SystemProgram } from "@solana/web3.js";
import { privateKeyToAccount } from "viem/accounts";
import { hashTypedData } from "viem";
import { RelayJournal } from "../../client/src/v2EvmRelayJournal.ts";
import { publicJob, RelayerWorker, loadRelayConfig } from "../../client/src/v2EvmRelayerService.ts";
import { prepareRelay, buildRelayInstruction, pinnedProgramHash } from "../../client/src/v2EvmRelayerCore.ts";
const require=createRequire(import.meta.url),path=fileURLToPath(new URL("../src/lib/v2EvmDevnet.ts",import.meta.url)),mod=new Module(path);
mod.filename=path;mod.paths=require.resolve.paths("viem");mod._compile(ts.transpileModule(readFileSync(path,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,path);
const h=mod.exports,v=JSON.parse(readFileSync(new URL("../../programs/yield-vault/tests/fixtures/evm-lifecycle.json",import.meta.url)));
const scratch=()=>join(mkdtempSync(join(tmpdir(),"evm-relay-journal-")),"journal.jsonl");
const digest=n=>"0x"+n.toString(16).padStart(64,"0");
const quoted=(n=1,nonce="2",cost=5000)=>({id:digest(n),safe:"safe",owner:"owner",nonce,state:"quoted",createdAt:Date.now(),intent:{nonce},plan:{feeLamports:cost},costLamports:cost});
const reserve=job=>({...job,state:"prepared",signature:"1234",wireBase64:"AQ==",lastValidBlockHeight:100});

test("independent lifecycle vectors match and changing sponsor/domain/action fails",async()=>{
 const create={action:"create_safe",cluster:"devnet",program:h.EVM_DEVNET_PROGRAM.toBase58(),genesisHash:h.EVM_DEVNET_GENESIS,owner:v.owner,safe:v.safe,mint:v.mint,rentPayer:v.rentPayer,nonce:"1",deadline:v.deadline,signature:v.createSignature};
 const cancel={action:"cancel_intents",cluster:"devnet",program:create.program,genesisHash:create.genesisHash,owner:v.owner,safe:v.safe,nonce:"9",deadline:v.deadline,signature:v.cancelSignature};
 assert.equal(await h.verifyEvmIntentSignature(create),v.createDigest);assert.equal(await h.verifyEvmIntentSignature(cancel),v.cancelDigest);
 for(const patch of [{rentPayer:Keypair.generate().publicKey.toBase58()},{mint:PublicKey.default.toBase58()},{safe:PublicKey.default.toBase58()},{program:PublicKey.default.toBase58()},{cluster:"mainnet"},{nonce:"2"},{deadline:"2000000001"}]) await assert.rejects(h.verifyEvmIntentSignature({...create,...patch}));
 await assert.rejects(h.verifyEvmIntentSignature({...cancel,signature:v.createSignature}));
 assert.equal(h.lifecycleTypedData(new PublicKey(v.safe),1n,2000000000n,new PublicKey(v.rentPayer)).primaryType,"CreateSafe");
});
test("journal survives restart and unresolved reservations never age out of sponsor budget",()=>{
 const path=scratch(),j=new RelayJournal(path),job=quoted(1,"2",8000000);job.createdAt=Date.now()-2*86400000;j.record(job);j.record(reserve(job));j.close();
 const restarted=new RelayJournal(path);assert.equal(restarted.get(job.id).state,"prepared");assert.throws(()=>restarted.assertBudget(3000000,{maxDailyLamports:10000000,maxHourlyTransactions:10}),/budget/);restarted.close();
});
test("single writer lock and truncated/corrupt journal fail closed",()=>{
 const path=scratch(),j=new RelayJournal(path);assert.throws(()=>new RelayJournal(path));j.close();writeFileSync(path,'{"partial":');assert.throws(()=>new RelayJournal(path),/truncated/);assert(!existsSync(path+'.lock'));
});
test("conflicting reserved nonces and modification of durable intent/wire are rejected",()=>{
 const path=scratch(),j=new RelayJournal(path),a=quoted(),b=quoted(2);j.record(a);j.record(b);j.record(reserve(a));assert.throws(()=>j.record(reserve(b)),/nonce/);
 assert.throws(()=>j.record({...reserve(a),state:"submitted",wireBase64:"Ag=="}));assert.throws(()=>j.record({...reserve(a),state:"submitted",intent:{nonce:"99"}}));j.close();
});
test("actual fees release unused rent reservation but hourly limit persists",()=>{
 const j=new RelayJournal(scratch()),job=quoted(1,"2",8000000);j.record(job);j.record(reserve(job));j.record({...reserve(job),state:"finalized",actualCostLamports:5000,slot:1});
 j.assertBudget(8000000,{maxDailyLamports:10000000,maxHourlyTransactions:10});assert.throws(()=>j.assertBudget(5000,{maxDailyLamports:10000000,maxHourlyTransactions:1}),/hourly/);
 assert.throws(()=>j.record({...reserve(job),state:"submitted"}),/transition/);j.close();
});
test("public job response never exposes owner signature, wire or private credentials",()=>{
 const job={...reserve(quoted()),intent:{signature:"owner-signature"},wireBase64:"wire"};const text=JSON.stringify(publicJob(job));assert(!text.includes("owner-signature"));assert(!text.includes("wire"));assert(text.includes('"signature":"1234"'));
});
test("send-disabled worker cannot sign or spend sponsor funds",async()=>{
 const signer=Keypair.generate(),j=new RelayJournal(scratch()),job=quoted();j.record(job);
 const worker=new RelayerWorker({payer:signer.publicKey.toBase58(),sendEnabled:false},{},signer,j);await assert.rejects(worker.approve(job.id,publicJob(job).planHash),/disabled/);assert.equal(j.get(job.id).state,"quoted");j.close();
});
test("unknown submission recovery checks original signature without generating another transaction",async()=>{
 const owner=privateKeyToAccount("0x"+randomBytes(32).toString("hex")),payer=Keypair.generate(),{safe}=h.deriveEvmSafe(owner.address),deadline=BigInt(Math.floor(Date.now()/1000)+600);
 const intent={owner:owner.address,safe:safe.toBase58(),allocationBps:[5000,0,0,0,0,0,0,0],nonce:"1",deadline:deadline.toString(),signature:await owner.signTypedData(h.allocationTypedData(safe,[5000,0,0,0,0,0,0,0],1n,deadline))};
 const tx=new Transaction({feePayer:payer.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58()}).add(await buildRelayInstruction({},intent,payer.publicKey));tx.sign(payer);
 const signature=h.solanaSignatureBase58(tx.signature),job={id:await h.verifyEvmIntentSignature(intent),safe:intent.safe,owner:intent.owner,nonce:"1",state:"quoted",createdAt:Date.now(),intent,plan:{feeLamports:5000},costLamports:5000};
 const j=new RelayJournal(scratch());j.record(job);j.record({...job,state:"prepared",signature,wireBase64:tx.serialize().toString("base64"),lastValidBlockHeight:100});j.record({...job,state:"unknown",signature,wireBase64:tx.serialize().toString("base64"),lastValidBlockHeight:100});
 let reads=0,sends=0;const rpc={getSignatureStatuses:async(values)=>{assert.deepEqual(values,[signature]);reads++;return{value:[null]};},sendRawTransaction:async()=>{sends++;throw Error("must not send");}};
 const worker=new RelayerWorker({payer:payer.publicKey.toBase58(),sendEnabled:true},rpc,payer,j);await worker.reconcile();assert.equal(reads,1);assert.equal(sends,0);assert.equal(j.get(job.id).state,"unknown");j.close();
});
test("signature, owner allowlist and cluster rejection happen before any transaction simulation",async()=>{
 const signer=privateKeyToAccount("0x"+randomBytes(32).toString("hex")),payer=Keypair.generate().publicKey,{safe}=h.deriveEvmSafe(signer.address),deadline=BigInt(Math.floor(Date.now()/1000)+600),allocationBps=[5000,0,0,0,0,0,0,0];
 const intent={owner:signer.address,safe:safe.toBase58(),allocationBps,nonce:"1",deadline:deadline.toString(),signature:await signer.signTypedData(h.allocationTypedData(safe,allocationBps,1n,deadline))};
 await assert.rejects(prepareRelay({},intent,payer,{allowedOwners:[]}),/allowlist/);
 await assert.rejects(prepareRelay({getGenesisHash:async()=>"mainnet"},intent,payer,{allowedOwners:[signer.address]}),/Devnet/);
 await assert.rejects(prepareRelay({}, {...intent,signature:"0x"+"00".repeat(65)},payer,{allowedOwners:[signer.address]}));
});
test("lifecycle API refuses missing-scope, unsafe creation nonce and foreign signature",()=>{
 assert.throws(()=>h.parseLifecycleIntent({action:"create_safe"}),/scope/);
 assert.throws(()=>h.lifecycleTypedData(new PublicKey(v.safe),2n,2000000000n,new PublicKey(v.rentPayer)),/creation nonce/);
 assert.throws(()=>h.parseEvmOwnerIntent({action:"execute_arbitrary_cpi"}),/action/);
});

test("pinned program binary and upgrade-authority payer are rejected before simulation",async()=>{
 const signer=privateKeyToAccount("0x"+randomBytes(32).toString("hex")),payer=Keypair.generate().publicKey,{safe}=h.deriveEvmSafe(signer.address),deadline=BigInt(Math.floor(Date.now()/1000)+600),allocationBps=[5000,0,0,0,0,0,0,0];
 const intent={owner:signer.address,safe:safe.toBase58(),allocationBps,nonce:"1",deadline:deadline.toString(),signature:await signer.signTypedData(h.allocationTypedData(safe,allocationBps,1n,deadline))};
 const loader=new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),[pdKey]=PublicKey.findProgramAddressSync([h.EVM_DEVNET_PROGRAM.toBuffer()],loader);
 const executable=Buffer.alloc(36);executable.writeUInt32LE(2);pdKey.toBuffer().copy(executable,4);
 const pd=Buffer.alloc(45+64);pd.writeUInt32LE(3);pd[12]=1;payer.toBuffer().copy(pd,13);
 const rpc={getGenesisHash:async()=>h.EVM_DEVNET_GENESIS,getMultipleAccountsInfo:async()=>[{executable:true,owner:loader,data:executable},{owner:loader,data:pd},{owner:SystemProgram.programId,lamports:50000000}]};
 const crypto=await import("node:crypto"),hash=crypto.createHash('sha256').update(pd.subarray(45)).digest('hex');
 await assert.rejects(prepareRelay(rpc,intent,payer,{allowedOwners:[signer.address],expectedElfBytes:64,expectedElfSha256:'f'.repeat(64)}),/binary changed/);
 await assert.rejects(prepareRelay(rpc,intent,payer,{allowedOwners:[signer.address],expectedElfBytes:64,expectedElfSha256:hash}),/upgrade authority/);
});
test("recovery rejects saved signed bytes that differ from the approved EVM action",async()=>{
 const signer=privateKeyToAccount("0x"+randomBytes(32).toString("hex")),payer=Keypair.generate(),{safe}=h.deriveEvmSafe(signer.address),deadline=BigInt(Math.floor(Date.now()/1000)+600),allocationBps=[5000,0,0,0,0,0,0,0];
 const intent={owner:signer.address,safe:safe.toBase58(),allocationBps,nonce:"1",deadline:deadline.toString(),signature:await signer.signTypedData(h.allocationTypedData(safe,allocationBps,1n,deadline))};
 const tx=new Transaction({feePayer:payer.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58()}).add(SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1}));tx.sign(payer);
 const job={id:await h.verifyEvmIntentSignature(intent),safe:intent.safe,owner:intent.owner,nonce:"1",state:"quoted",createdAt:Date.now(),intent,plan:{feeLamports:5000},costLamports:5000},j=new RelayJournal(scratch());j.record(job);j.record({...job,state:"prepared",signature:h.solanaSignatureBase58(tx.signature),wireBase64:tx.serialize().toString('base64'),lastValidBlockHeight:100});
 const worker=new RelayerWorker({payer:payer.publicKey.toBase58(),sendEnabled:true},{},payer,j);await assert.rejects(worker.reconcile(),/saved wire differs/);assert.equal(j.get(job.id).state,'prepared');j.close();
});

test("program pin accepts reserved zero padding but rejects changed code, size or nonzero tail",async()=>{
 const {createHash}=await import("node:crypto"),elf=Buffer.from([1,2,3,4]),data=Buffer.concat([Buffer.alloc(45),elf,Buffer.alloc(10240)]),policy={expectedElfBytes:4,expectedElfSha256:createHash("sha256").update(elf).digest("hex")};
 assert.equal(pinnedProgramHash(data,policy),policy.expectedElfSha256);
 const changed=Buffer.from(data);changed[45]^=1;assert.throws(()=>pinnedProgramHash(changed,policy),/binary changed/);
 const tail=Buffer.from(data);tail[tail.length-1]=1;assert.throws(()=>pinnedProgramHash(tail,policy),/padding/);
 assert.throws(()=>pinnedProgramHash(data,{...policy,expectedElfBytes:0}),/size/);
});
