/** Devnet simulations only: ephemeral EVM test owner; no Solana signer or submission. */
import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {AnchorProvider,Program} from "@coral-xyz/anchor";
import BN from "bn.js";
import {Connection,PublicKey,SystemProgram,Transaction,VersionedTransaction,ComputeBudgetProgram} from "@solana/web3.js";
import {TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID} from "@solana/spl-token";
import {generatePrivateKey,privateKeyToAccount} from "viem/accounts";
import {deriveEvmSafe,lifecycleTypedData,EVM_DEVNET_PROGRAM,EVM_DEVNET_USDC_MINT,EVM_DEVNET_GENESIS} from "../src/lib/v2EvmDevnet.ts";
const connection=new Connection(process.env.V2_DEVNET_RPC_URL||"https://api.devnet.solana.com","finalized"),payer=new PublicKey("GhK2bfKSsFgVrm6RbgHZkMzQ34pvYh5tGjfda3UchY1s");
assert.equal(await connection.getGenesisHash(),EVM_DEVNET_GENESIS);
const loader=new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),[pd]=PublicKey.findProgramAddressSync([EVM_DEVNET_PROGRAM.toBuffer()],loader),info=await connection.getAccountInfo(pd,"finalized");
assert.equal(createHash("sha256").update(info.data.subarray(45,45+695488)).digest("hex"),"4a2a277a6df06bbcafe172f90ff88bfc3d31fe34b4309b2b6913a4d7b70fdf98");assert(info.data.subarray(45+695488).every(x=>x===0));
const owner=privateKeyToAccount(generatePrivateKey()),{safe,ata,ownerBytes}=deriveEvmSafe(owner.address),deadline=BigInt(Math.floor(Date.now()/1000)+600);
assert.equal(await connection.getAccountInfo(safe,"finalized"),null);const before=await connection.getBalance(payer,"finalized");
const wallet={publicKey:payer,signTransaction:async()=>{throw Error("Simulation only");},signAllTransactions:async()=>{throw Error("Simulation only");}};
const program=new Program(JSON.parse(readFileSync(new URL("../src/idl/yield_vault_evm_devnet.json",import.meta.url),"utf8")),new AnchorProvider(connection,wallet,{commitment:"confirmed"}));
const accounts={payer,evmVault:safe,usdcMint:EVM_DEVNET_USDC_MINT,vaultUsdcAta:ata,tokenProgram:TOKEN_PROGRAM_ID,associatedTokenProgram:ASSOCIATED_TOKEN_PROGRAM_ID,systemProgram:SystemProgram.programId};
const bytes=s=>[...Buffer.from(s.slice(2),"hex")],createSignature=await owner.signTypedData(lifecycleTypedData(safe,1n,deadline,payer));
const create=signature=>program.methods.createEvmSafeAuthorized([...ownerBytes],new BN(1),new BN(deadline.toString()),bytes(signature)).accountsStrict(accounts).instruction();
const cancelSignature=await owner.signTypedData(lifecycleTypedData(safe,2n,deadline));
const cancel=await program.methods.evmCancelIntents(new BN(2),new BN(deadline.toString()),bytes(cancelSignature)).accountsStrict({payer,evmVault:safe}).instruction();
const results=[];
async function probe(name,instructions,errorName){
 const tx=new Transaction({feePayer:payer,recentBlockhash:(await connection.getLatestBlockhash("confirmed")).blockhash}).add(ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),...instructions);
 const r=(await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()),{sigVerify:false,replaceRecentBlockhash:true,commitment:"confirmed",accounts:{encoding:"base64",addresses:[payer.toBase58(),safe.toBase58(),ata.toBase58()]}})).value;
 if(errorName){assert(r.err,name+" unexpectedly succeeded");assert((r.logs||[]).some(x=>x.includes(errorName)),name+" rejected for unexpected reason: "+JSON.stringify(r.err)+(r.logs||[]).join(" "));}
 else {assert.equal(r.err,null);const v=Buffer.from(r.accounts[1].data[0],"base64"),t=Buffer.from(r.accounts[2].data[0],"base64");assert.equal(v.length,705);assert.equal(v.readBigUInt64LE(61),2n);assert(v.subarray(9,29).equals(Buffer.from(ownerBytes)));assert(new PublicKey(v.subarray(29,61)).equals(payer));assert.equal(t.readBigUInt64LE(64),0n);}
 results.push({name,passed:true,errorName:errorName||null,computeUnits:r.unitsConsumed});
}
const authorized=await create(createSignature);
await probe("signed creation followed by signed cancellation",[authorized,cancel]);
await probe("legacy unsigned creation",[await program.methods.createEvmSafe([...ownerBytes]).accountsStrict(accounts).instruction()],"OwnerSignatureRequired");
const wrong=await owner.signTypedData(lifecycleTypedData(safe,1n,deadline,new PublicKey("8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A")));
await probe("sponsor substitution",[await create(wrong)],"WrongSigner");
await probe("cancel replay",[authorized,cancel,cancel],"InvalidNonce");
const expired=BigInt(Math.floor(Date.now()/1000)-60),expiredSig=await owner.signTypedData(lifecycleTypedData(safe,1n,expired,payer));
await probe("expired creation",[await program.methods.createEvmSafeAuthorized([...ownerBytes],new BN(1),new BN(expired.toString()),bytes(expiredSig)).accountsStrict(accounts).instruction()],"SignatureExpired");
const high=Buffer.from(createSignature.slice(2),"hex"),order=BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");Buffer.from((order-BigInt("0x"+high.subarray(32,64).toString("hex"))).toString(16).padStart(64,"0"),"hex").copy(high,32);high[64]=high[64]===27?28:27;
await probe("high-s malleable creation",[await create("0x"+high.toString("hex"))],"HighSignatureS");
assert.equal(await connection.getAccountInfo(safe,"finalized"),null);assert.equal(await connection.getAccountInfo(ata,"finalized"),null);assert.equal(await connection.getBalance(payer,"finalized"),before);
const result={cluster:"devnet",program:EVM_DEVNET_PROGRAM.toBase58(),status:"six_live_simulations_passed",ephemeralTestOwner:owner.address,testSafe:safe.toBase58(),payer:payer.toBase58(),payerBalanceUnchanged:true,testSafeCreated:false,transactionsSent:false,solanaSignerFilesRead:false,results,verifiedAt:new Date().toISOString()};
writeFileSync(new URL("../../docs/yield-ai-v2-evm-lifecycle-devnet-probe-result.json",import.meta.url),JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify(result));
