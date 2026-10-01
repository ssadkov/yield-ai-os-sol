/** Read-only Squads proposal preflight for the exact small Devnet rehearsal. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const bs58=createRequire(import.meta.url)("bs58") as {encode(bytes:Uint8Array):string};
import * as squads from "@sqds/multisig";
import { Connection, PublicKey, TransactionInstruction, Transaction, VersionedTransaction, TransactionMessage, Message, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { GOVERNANCE_MEMBERS, OPERATOR, validateGovernance, SQUADS_PROGRAM } from "./v2EvmGovernancePolicy.ts";

const memoProgram=new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),memo="Yield AI Devnet governance rehearsal: 2of3,3600s";
const buildMode=process.argv[2]==="--message";
const index=buildMode?0n:BigInt(process.argv[2]||"0");assert(buildMode||index>0n,"Supply --message or actual rehearsal proposal index");
const connection=new Connection(process.env.V2_DEVNET_RPC_URL||"https://api.devnet.solana.com","finalized");
assert.equal(await connection.getGenesisHash(),"EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
const multisig=new PublicKey("GGLdf4MtQkT98QoaDLyadrsn9rcEzRw1BxhaAkvvPN5r");
if(buildMode){
 const info=await connection.getAccountInfo(multisig,"finalized");assert(info);const {vault,config}=validateGovernance(info,multisig);
 const message=Message.compile({payerKey:vault,recentBlockhash:(await connection.getLatestBlockhash("confirmed")).blockhash,instructions:[new TransactionInstruction({programId:memoProgram,keys:[{pubkey:vault,isSigner:true,isWritable:false}],data:Buffer.from(memo)})]});
 const nextIndex=BigInt(config.transactionIndex.toString())+1n,creator=new PublicKey(GOVERNANCE_MEMBERS[0]);
 const body=new TransactionMessage({payerKey:vault,recentBlockhash:message.recentBlockhash,instructions:[new TransactionInstruction({programId:memoProgram,keys:[{pubkey:vault,isSigner:true,isWritable:false}],data:Buffer.from(memo)})]});
 const proposalInstructions=[
  squads.instructions.vaultTransactionCreate({multisigPda:multisig,transactionIndex:nextIndex,creator,rentPayer:OPERATOR,vaultIndex:0,ephemeralSigners:0,transactionMessage:body}),
  squads.instructions.proposalCreate({multisigPda:multisig,transactionIndex:nextIndex,creator,rentPayer:OPERATOR,isDraft:false}),
  squads.instructions.proposalApprove({multisigPda:multisig,transactionIndex:nextIndex,member:creator})
 ];
 const [proposalAddress]=squads.getProposalPda({multisigPda:multisig,transactionIndex:nextIndex});
 const unsigned=new Transaction({feePayer:OPERATOR,recentBlockhash:message.recentBlockhash}).add(...proposalInstructions);
 const simulated=(await connection.simulateTransaction(new VersionedTransaction(unsigned.compileMessage()),{sigVerify:false,replaceRecentBlockhash:true,commitment:"confirmed",accounts:{encoding:"base64",addresses:[proposalAddress.toBase58()]}})).value;
 assert.equal(simulated.err,null);assert(simulated.accounts?.[0]);
 const projected=simulated.accounts[0];assert.equal(projected.owner,SQUADS_PROGRAM.toBase58());
 const [projectedProposal]=squads.accounts.Proposal.deserialize(Buffer.from(projected.data[0],"base64"));
 assert.equal(projectedProposal.status.__kind,"Active");assert.deepEqual(projectedProposal.approved.map(k=>k.toBase58()),[GOVERNANCE_MEMBERS[0]]);
 assert.equal(await connection.getAccountInfo(proposalAddress,"finalized"),null,"simulation must not create an account");
 const result={cluster:"devnet",multisig:multisig.toBase58(),vault:vault.toBase58(),vaultIndex:0,nextProposalIndex:nextIndex.toString(),unsignedProposalAndFirstVoteSimulationPassed:true,simulationSignatureVerification:false,simulationPayer:OPERATOR.toBase58(),actualUiPayer:"connected member wallet",action:"memo_only_governance_rehearsal",memo,program:memoProgram.toBase58(),amountLamports:0,unsignedMessageBase58:bs58.encode(message.serialize()),walletMustSignProposal:true,transactionsSent:false,signerFilesRead:false};
 writeFileSync(new URL("../../docs/yield-ai-v2-evm-governance-rehearsal-message.json",import.meta.url),JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify(result));
} else {
const [transactionAddress]=squads.getTransactionPda({multisigPda:multisig,index}),[proposalAddress]=squads.getProposalPda({multisigPda:multisig,transactionIndex:index});
const state=await connection.getMultipleAccountsInfoAndContext([multisig,transactionAddress,proposalAddress,SYSVAR_CLOCK_PUBKEY],"finalized");
const [configInfo,txInfo,proposalInfo,clock]=state.value;assert(configInfo&&txInfo&&proposalInfo&&clock);
const {config,vault}=validateGovernance(configInfo,multisig);
assert(txInfo.owner.equals(SQUADS_PROGRAM)&&proposalInfo.owner.equals(SQUADS_PROGRAM));
assert(txInfo.data.subarray(0,8).equals(Buffer.from(squads.accounts.vaultTransactionDiscriminator)));
assert(proposalInfo.data.subarray(0,8).equals(Buffer.from(squads.accounts.proposalDiscriminator)));
const [stored]=squads.accounts.VaultTransaction.fromAccountInfo(txInfo),[proposal]=squads.accounts.Proposal.fromAccountInfo(proposalInfo);
assert(stored.multisig.equals(multisig)&&proposal.multisig.equals(multisig)&&stored.index.toString()===index.toString()&&proposal.transactionIndex.toString()===index.toString());
assert.equal(stored.vaultIndex,0);assert.equal(stored.ephemeralSignerBumps.length,0);
assert.equal(stored.message.instructions.length,1);assert.equal(stored.message.addressTableLookups.length,0);
const ix=stored.message.instructions[0],keys=stored.message.accountKeys;
assert(keys[ix.programIdIndex].equals(memoProgram));assert(Buffer.from(ix.data).equals(Buffer.from(memo)));
assert.equal(ix.accountIndexes.length,1);assert(keys[ix.accountIndexes[0]].equals(vault));assert.equal(stored.message.numSigners,1);
assert.equal(new Set(proposal.approved.map(k=>k.toBase58())).size,proposal.approved.length);
assert(proposal.approved.every(k=>GOVERNANCE_MEMBERS.includes(k.toBase58())));
assert.equal(proposal.rejected.length,0);assert.equal(proposal.cancelled.length,0);
assert(index>BigInt(config.staleTransactionIndex.toString()),"proposal invalidated by config change");
const member=new PublicKey(GOVERNANCE_MEMBERS[0]),clockTime=clock.data.readBigInt64LE(32);
const approved=proposal.status.__kind==="Approved";
const executableAt=approved?BigInt(proposal.status.timestamp.toString())+BigInt(config.timeLock):null;
const {instruction,lookupTableAccounts}=await squads.instructions.vaultTransactionExecute({connection,multisigPda:multisig,transactionIndex:index,member});
assert.equal(lookupTableAccounts.length,0);
const block=await connection.getLatestBlockhash("confirmed"),tx=new Transaction({feePayer:member,recentBlockhash:block.blockhash}).add(instruction);
const simulation=(await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()),{sigVerify:false,replaceRecentBlockhash:true,commitment:"confirmed"})).value;
let outcome:string;
if(proposal.status.__kind==="Active"&&proposal.approved.length===1){
 assert(simulation.err&&(simulation.logs||[]).some(l=>l.includes("InvalidProposalStatus")));outcome="single_vote_execution_rejected";
} else if(approved&&executableAt!==null&&clockTime<executableAt){
 assert.equal(proposal.approved.length,2,"use exactly two votes for the threshold rehearsal");
 assert(simulation.err&&(simulation.logs||[]).some(l=>l.includes("TimeLockNotReleased")));outcome="two_votes_early_execution_rejected";
} else if(approved&&executableAt!==null&&clockTime>=executableAt){
 assert.equal(simulation.err,null);outcome="threshold_and_one_hour_elapsed_execution_simulates";
} else if(proposal.status.__kind==="Executed"){
 assert(simulation.err);outcome="executed_proposal_replay_rejected";
} else throw Error("Unexpected rehearsal proposal status");
const result={status:outcome,cluster:"devnet",multisig:multisig.toBase58(),vault:vault.toBase58(),proposal:proposalAddress.toBase58(),transactionIndex:index.toString(),proposalStatus:proposal.status.__kind,approved:proposal.approved.map(k=>k.toBase58()),threshold:2,timeLockSeconds:3600,chainTime:clockTime.toString(),executableAt:executableAt?.toString()||null,action:"memo_only_governance_rehearsal",memo,amountLamports:0,sourceReadSlot:state.context.slot,transactionsSent:false,signerFilesRead:false,verifiedAt:new Date().toISOString()};
writeFileSync(new URL("../../docs/yield-ai-v2-evm-governance-proposal-"+index+"-"+outcome+".json",import.meta.url),JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify(result));

}
