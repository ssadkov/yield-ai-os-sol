/** Human cancellation proof: no sends/signers; input signatures never enter public receipts. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { AnchorProvider, Program, BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import BN from "bn.js";
import type { EvmOwnerIntent } from "../../web/src/lib/v2EvmDevnet.ts";
const require=createRequire(import.meta.url),helperPath=fileURLToPath(new URL("../../web/src/lib/v2EvmDevnet.ts",import.meta.url)),mod=new Module(helperPath);
mod.filename=helperPath;mod.paths=createRequire(helperPath).resolve.paths("viem")!;
(mod as unknown as { _compile(code:string,path:string):void })._compile(ts.transpileModule(readFileSync(helperPath,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,helperPath);
const {deriveEvmSafe,parseEvmOwnerIntent,verifyEvmIntentSignature,EVM_DEVNET_GENESIS,EVM_DEVNET_PROGRAM}=mod.exports as typeof import("../../web/src/lib/v2EvmDevnet.ts");

import { OPERATOR, RELAYER } from "./v2EvmGovernancePolicy.ts";
const connection=new Connection(process.env.V2_DEVNET_RPC_URL||"https://api.devnet.solana.com","finalized");
assert.equal(await connection.getGenesisHash(),EVM_DEVNET_GENESIS);
const owner="0xb659DA13418527601C52D4220536C12397F20855",{safe,ata,ownerBytes}=deriveEvmSafe(owner);
const snapshotPath=new URL("../../docs/yield-ai-v2-evm-cancel-before.json",import.meta.url);
const resultPath=new URL("../../docs/yield-ai-v2-evm-cancel-result.json",import.meta.url);
const masked=(data:Buffer)=>{const copy=Buffer.from(data);copy.fill(0,61,69);return createHash("sha256").update(copy).digest("hex");};
async function readState(){
 const r=await connection.getMultipleAccountsInfoAndContext([safe,ata,RELAYER],"finalized");
 const [vault,token,payer]=r.value;assert(vault&&token&&payer&&vault.owner.equals(EVM_DEVNET_PROGRAM)&&vault.data.length===705);
 assert(vault.data.subarray(9,29).equals(Buffer.from(ownerBytes)));
 assert.equal(token.data.length,165);assert(new PublicKey(token.data.subarray(32,64)).equals(safe));
 return {slot:r.context.slot,nonce:vault.data.readBigUInt64LE(61).toString(),safeMaskedSha256:masked(vault.data),safeLamports:vault.lamports,ataSha256:createHash("sha256").update(token.data).digest("hex"),ataLamports:token.lamports,usdcRaw:token.data.readBigUInt64LE(64).toString(),sponsorLamports:payer.lamports};
}
async function buildRelayInstruction(connection:Connection,intent:EvmOwnerIntent,payer:PublicKey) {
 const idl=JSON.parse(readFileSync(new URL("../../web/src/idl/yield_vault_evm_devnet.json",import.meta.url),"utf8")) as Idl;
 const provider=new AnchorProvider(connection,{publicKey:payer,signTransaction:async()=>{throw Error("read-only");},signAllTransactions:async()=>{throw Error("read-only");}},{commitment:"confirmed"});
 const p=new Program(idl,provider),args=[new BN(intent.nonce),new BN(intent.deadline),[...Buffer.from(intent.signature.slice(2),"hex")]];
 return "action" in intent ? p.methods.evmCancelIntents(...args).accountsStrict({payer,evmVault:safe}).instruction() : p.methods.evmSetAllocation(intent.allocationBps,...args).accountsStrict({payer,evmVault:safe}).instruction();
}
async function main(){
 const loader=new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),[pd]=PublicKey.findProgramAddressSync([EVM_DEVNET_PROGRAM.toBuffer()],loader);
 const info=await connection.getAccountInfo(pd,"finalized");assert(info);assert(info.owner.equals(loader)&&info.data.length===699149&&info.data[12]===1&&new PublicKey(info.data.subarray(13,45)).equals(OPERATOR));
 assert.equal(createHash("sha256").update(info.data.subarray(45,45+695488)).digest("hex"),"4a2a277a6df06bbcafe172f90ff88bfc3d31fe34b4309b2b6913a4d7b70fdf98");assert(info.data.subarray(45+695488).every(x=>x===0));
 if(process.argv[2]==="--snapshot"){
  const s=await readState();assert.equal(s.nonce,"2","snapshot must precede owner cancellation");assert.equal(s.usdcRaw,"0");
  const result={cluster:"devnet",owner,safe:safe.toBase58(),ata:ata.toBase58(),...s,observedAt:new Date().toISOString(),transactionsSent:false,signerFilesRead:false};
  writeFileSync(snapshotPath,JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify(result));return;
 }
 assert.equal(process.argv[2],"--verify-stdin","Use --snapshot or --verify-stdin");
 const input=JSON.parse(readFileSync(0,"utf8")),stale=parseEvmOwnerIntent(input.staleIntent);
 assert(!("action" in stale),"use allocation target as the harmless competing intent");
 assert.equal(stale.owner.toLowerCase(),owner.toLowerCase());assert.deepEqual(stale.allocationBps,[5000,0,0,0,0,0,0,0]);assert.equal(stale.nonce,"3");
 const staleDigest=await verifyEvmIntentSignature(stale);
 assert(BigInt(stale.deadline)>BigInt(Math.floor(Date.now()/1000)),"expired signature cannot establish nonce rejection");
 const receipt=await connection.getTransaction(input.cancelTx,{commitment:"finalized",maxSupportedTransactionVersion:0});
 assert(receipt?.meta&&!receipt.meta.err);assert.equal(receipt.meta.fee,5000);
 const keys=receipt.transaction.message.getAccountKeys(),ixs=receipt.transaction.message.compiledInstructions;
 assert.equal(keys.get(0)?.toBase58(),RELAYER.toBase58());assert.equal(ixs.length,1);
 const ix=ixs[0];assert.equal(keys.get(ix.programIdIndex)?.toBase58(),EVM_DEVNET_PROGRAM.toBase58());
 assert.deepEqual(ix.accountKeyIndexes.map(i=>keys.get(i)?.toBase58()),[RELAYER.toBase58(),safe.toBase58()]);
 const coder=new BorshInstructionCoder(JSON.parse(readFileSync(new URL("../../web/src/idl/yield_vault_evm_devnet.json",import.meta.url),"utf8")) as Idl);
 const decoded=coder.decode(Buffer.from(ix.data));assert(decoded&&decoded.name==="evm_cancel_intents");
 const args=decoded.data as {nonce:{toString():string};deadline:{toString():string};signature:number[]};
 const cancel=parseEvmOwnerIntent({action:"cancel_intents",cluster:"devnet",program:EVM_DEVNET_PROGRAM.toBase58(),genesisHash:EVM_DEVNET_GENESIS,owner,safe:safe.toBase58(),nonce:args.nonce.toString(),deadline:args.deadline.toString(),signature:"0x"+Buffer.from(args.signature).toString("hex")});
 assert.equal(cancel.nonce,stale.nonce);const cancelDigest=await verifyEvmIntentSignature(cancel);
 const before=JSON.parse(readFileSync(snapshotPath,"utf8")),after=await readState();assert(before.slot<receipt.slot&&after.slot>=receipt.slot);
 assert.equal(before.nonce,"2");assert.equal(after.nonce,"3");
 for(const k of ["safeMaskedSha256","safeLamports","ataSha256","ataLamports","usdcRaw"] as const)assert.equal(after[k],before[k],"unexpected state change: "+k);
 const feeDebit=receipt.meta.preBalances[0]-receipt.meta.postBalances[0];assert.equal(feeDebit,5000);
 const probes=[];
 for(const [name,intent] of [["cancelled allocation",stale],["cancellation replay",cancel]] as const){
  assert(BigInt(intent.deadline)>BigInt(Math.floor(Date.now()/1000)),"expiry would confound nonce test");
  const instruction=await buildRelayInstruction(connection,intent,RELAYER),block=await connection.getLatestBlockhash("confirmed");
  const tx=new Transaction({feePayer:RELAYER,recentBlockhash:block.blockhash}).add(instruction);
  const simulation=(await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()),{sigVerify:false,replaceRecentBlockhash:true,commitment:"confirmed"})).value;
  assert(simulation.err&&(simulation.logs||[]).some(x=>x.includes("InvalidNonce")),"expected on-chain InvalidNonce");
  const api=await fetch("http://localhost:3101/api/v2/evm-devnet",{method:"POST",headers:{"content-type":"application/json",origin:"http://localhost:3101"},body:JSON.stringify(intent),signal:AbortSignal.timeout(30000)});
  const response=await api.json() as {error?:string};assert.equal(api.status,409);assert(response.error?.includes("nonce changed"));
  probes.push({name,onChainError:"InvalidNonce",apiStatus:api.status,signatureStillUnexpired:true});
 }
 const final=await readState();assert.deepEqual(final,{...after,slot:final.slot},"read-only checks changed state");
 const job=await fetch("http://localhost:3101/api/v2/evm-relay?id="+cancelDigest).then(r=>r.json()) as {state:string;signature:string;actualCostLamports:number};
 assert(job.state==="finalized"&&job.signature===input.cancelTx&&job.actualCostLamports===5000);
 const result={status:"human_cancel_wins_stale_action_and_replay_rejected",cluster:"devnet",owner,safe:safe.toBase58(),signature:input.cancelTx,slot:receipt.slot,staleDigest,cancelDigest,nonceBefore:"2",nonceAfter:"3",amountMovedRaw:"0",safeAndAtaUnchangedExceptNonce:true,feePayer:RELAYER.toBase58(),feeLamports:5000,rentLamports:0,probes,relayerState:job.state,verifiedAt:new Date().toISOString(),verificationTransactionsSent:false,signerFilesRead:false};
 writeFileSync(resultPath,JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify(result));
}
await main();
