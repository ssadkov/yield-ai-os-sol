import test from "node:test";
import assert from "node:assert/strict";
import * as squads from "@sqds/multisig";
import { PublicKey, Keypair } from "@solana/web3.js";
import { validateGovernance, GOVERNANCE_MEMBERS, GOVERNANCE_TIMELOCK, SQUADS_PROGRAM, RELAYER } from "../src/v2EvmGovernancePolicy.ts";

const createKey=Keypair.generate().publicKey,[address,bump]=squads.getMultisigPda({createKey});
const valid={createKey,configAuthority:PublicKey.default,threshold:2,timeLock:GOVERNANCE_TIMELOCK,transactionIndex:0n,staleTransactionIndex:0n,rentCollector:null,bump,members:GOVERNANCE_MEMBERS.map(key=>({key:new PublicKey(key),permissions:{mask:7}}))};
function account(patch={}){return {owner:SQUADS_PROGRAM,executable:false,data:squads.accounts.Multisig.fromArgs({...valid,...patch}).serialize()[0]};}
test("official SDK account roundtrip validates three user-selected Solana members and vault derivation",()=>{
 const {config,vault}=validateGovernance(account(),address);assert.equal(config.threshold,2);assert.equal(config.timeLock,3600);
 assert(vault.equals(squads.getVaultPda({multisigPda:address,index:0})[0]));
});
for(const [name,patch] of [
 ["single signature threshold",{threshold:1}],["zero timelock",{timeLock:0}],["wrong cluster policy timelock",{timeLock:172800}],
 ["external config authority",{configAuthority:Keypair.generate().publicKey}],["extra member",{members:[...valid.members,{key:Keypair.generate().publicKey,permissions:{mask:7}}]}],
 ["duplicate members",{members:[valid.members[0],valid.members[0],valid.members[2]]}],["relayer in membership",{members:[valid.members[0],valid.members[1],{key:RELAYER,permissions:{mask:7}}]}],
 ["missing vote permission",{members:valid.members.map((m,i)=>i===0?{...m,permissions:{mask:5}}:m)}],
]) test("reject "+name,()=>assert.throws(()=>validateGovernance(account(patch),address)));
test("reject lookalike owned by another program, wrong PDA, discriminator and truncation",()=>{
 assert.throws(()=>validateGovernance({...account(),owner:PublicKey.default},address));
 assert.throws(()=>validateGovernance(account(),Keypair.generate().publicKey));
 const a=account();a.data[0]^=1;assert.throws(()=>validateGovernance(a,address));
 assert.throws(()=>validateGovernance({...account(),data:account().data.subarray(0,80)},address));
});
