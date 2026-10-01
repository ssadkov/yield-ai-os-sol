/** Isolated local validator only. Ephemeral keys stay in memory; no public RPC or wallet files. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import ts from "typescript";
import BN from "bn.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, Transaction, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, MintLayout, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction, createMintToInstruction, createTransferCheckedInstruction,
  createSetAuthorityInstruction, createFreezeAccountInstruction, createThawAccountInstruction, AuthorityType, getAccount } from "@solana/spl-token";
import { privateKeyToAccount } from "viem/accounts";
import { bytesToHex, hashTypedData } from "viem";

const require = createRequire(import.meta.url), helperPath = fileURLToPath(new URL("../src/lib/v2EvmDevnet.ts", import.meta.url));
const mod = new Module(helperPath); mod.filename = helperPath; mod.paths = require.resolve.paths("viem");
mod._compile(ts.transpileModule(readFileSync(helperPath,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,helperPath);
const { EVM_DEVNET_PROGRAM: programId, EVM_DEVNET_USDC_MINT: mint, deriveEvmSafe, withdrawalTypedData, allocationTypedData, lifecycleTypedData } = mod.exports;
const idl = JSON.parse(readFileSync(new URL("../src/idl/yield_vault_evm_devnet.json",import.meta.url)));
const fullIdl = JSON.parse(readFileSync(new URL("../../target/idl/yield_vault.json",import.meta.url)));
const binary = fileURLToPath(new URL("../../target/deploy/yield_vault.so",import.meta.url));
const payer = Keypair.generate(), controller = Keypair.generate(), otherController = Keypair.generate();
const account = privateKeyToAccount("0x"+randomBytes(32).toString("hex"));
const { ownerBytes, safe, ata } = deriveEvmSafe(account.address);
const secondAccount = privateKeyToAccount("0x"+randomBytes(32).toString("hex"));
const second = deriveEvmSafe(secondAccount.address);
const alternatePayer = Keypair.generate();
const recipient = getAssociatedTokenAddressSync(mint,controller.publicKey), alternative = getAssociatedTokenAddressSync(mint,otherController.publicKey);
const wrongMint = Keypair.generate().publicKey;
const source = getAssociatedTokenAddressSync(mint,payer.publicKey);
const scratch = mkdtempSync(join(tmpdir(),"yield-evm-withdraw-local-"));
function mintFixture(address,name) {
  const data=Buffer.alloc(MintLayout.span); MintLayout.encode({mintAuthorityOption:1,mintAuthority:payer.publicKey,supply:0n,decimals:6,isInitialized:true,freezeAuthorityOption:1,freezeAuthority:payer.publicKey},data);
  const path=join(scratch,name+".json");writeFileSync(path,JSON.stringify({pubkey:address.toBase58(),account:{lamports:1461600,data:[data.toString("base64"),"base64"],owner:TOKEN_PROGRAM_ID.toBase58(),executable:false,rentEpoch:0}}));return path;
}
const mintPath=mintFixture(mint,"usdc"),wrongMintPath=mintFixture(wrongMint,"wrong-mint");
const connection=new Connection("http://127.0.0.1:18899","confirmed");
const program=new Program(idl,new AnchorProvider(connection,new Wallet(payer),{commitment:"confirmed"}));
const legacyProgram = new Program(fullIdl, new AnchorProvider(connection,new Wallet(payer),{commitment:"confirmed"}));
const log = openSync(join(scratch,"validator.log"),"w");
const validator=spawn("solana-test-validator",["--ledger",join(scratch,"ledger"),"--rpc-port","18899","--faucet-port","19999","--dynamic-port-range","20000-20030","--bind-address","127.0.0.1","--bpf-program",programId.toBase58(),binary,"--account",mint.toBase58(),mintPath,"--account",wrongMint.toBase58(),wrongMintPath,"--quiet"],{env:{...process.env,NO_DNA:"1"},stdio:["ignore",log,log]});
let spawnError;validator.on("error",e=>{spawnError=e;});
const state=()=>program.account.evmVault.fetch(safe);
const balances=async()=>[(await getAccount(connection,ata)).amount,(await getAccount(connection,recipient)).amount,(await state()).nonce.toString()];
const rejected=[];
async function transaction(ixs,signers=[payer],feePayer=payer.publicKey) {
  const tx=new Transaction().add(...ixs);tx.feePayer=feePayer;tx.recentBlockhash=(await connection.getLatestBlockhash()).blockhash;
  return {tx,signers};
}
async function confirm(signature) {
  for (let n=0;n<100;n++) {
    const result=(await connection.getSignatureStatuses([signature])).value[0];
    if(result) { assert.equal(result.err,null,JSON.stringify(result.err)); if(result.confirmationStatus==="confirmed" || result.confirmationStatus==="finalized") return; }
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error("local transaction confirmation timed out: "+signature);
}
async function send(ixs,signers=[payer],feePayer=payer.publicKey) {
  const {tx}=await transaction(ixs,signers,feePayer),simulation=await connection.simulateTransaction(tx);
  assert.equal(simulation.value.err,null,JSON.stringify(simulation.value.err)+" "+simulation.value.logs?.join("\n"));
  tx.sign(...signers);
  const signature=await connection.sendRawTransaction(tx.serialize(),{skipPreflight:false}); await confirm(signature);
  return {signature,computeUnits:simulation.value.unitsConsumed};
}
async function deny(name,ix) {
  const before=await balances(),{tx}=await transaction([ComputeBudgetProgram.setComputeUnitLimit({units:200000+rejected.length}),ix]);
  const simulation=await connection.simulateTransaction(tx);
  assert.notEqual(simulation.value.err,null,name+" must be rejected");
  assert.deepEqual(await balances(),before,name+" must preserve nonce and balances");
  rejected.push({name,error:simulation.value.err});
}
function highS(signature) {
  const order=0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n,s=BigInt("0x"+signature.slice(66,130));
  return "0x"+signature.slice(2,66)+(order-s).toString(16).padStart(64,"0")+(signature.slice(130)==="1b"?"1c":"1b");
}
async function withdrawIx(amount,nonce,deadline,signature,overrides={}) {
  return program.methods.evmWithdrawUsdc(new BN(amount.toString()),new BN(nonce.toString()),new BN(deadline.toString()),[...Buffer.from(signature.slice(2),"hex")]).accountsStrict({payer:payer.publicKey,evmVault:safe,usdcMint:mint,vaultUsdcAta:ata,recipientUsdcAccount:recipient,tokenProgram:TOKEN_PROGRAM_ID,...overrides}).instruction();
}
try {
  console.log(JSON.stringify({status:"starting_local_validator",cluster:"localnet",rpc:"http://127.0.0.1:18899",scratch}));
  for(let n=0;n<60;n++) {if(spawnError)throw spawnError;if(validator.exitCode!==null)throw Error("validator exited: "+readFileSync(join(scratch,"validator.log"),"utf8").slice(-3000));try{await connection.getVersion();break;}catch{if(n===59)throw Error("validator did not become ready");await new Promise(r=>setTimeout(r,1000));}}
  const air=await connection.requestAirdrop(payer.publicKey,2_000_000_000);await confirm(air);
  const legacyCreate=await program.methods.createEvmSafe([...ownerBytes]).accountsStrict({payer:payer.publicKey,evmVault:safe,usdcMint:mint,vaultUsdcAta:ata,tokenProgram:TOKEN_PROGRAM_ID,associatedTokenProgram:ASSOCIATED_TOKEN_PROGRAM_ID,systemProgram:SystemProgram.programId}).instruction();
  const legacySimulation=await connection.simulateTransaction((await transaction([legacyCreate])).tx);
  assert.notEqual(legacySimulation.value.err,null,"unsigned creation must fail");
  assert.equal(await connection.getAccountInfo(safe),null,"failed creation must preserve absent Safe");
  const creationDeadline=BigInt(Math.floor(Date.now()/1000)+600);
  const createSig=await account.signTypedData(lifecycleTypedData(safe,1n,creationDeadline,payer.publicKey));
  const create=await program.methods.createEvmSafeAuthorized([...ownerBytes],new BN(1),new BN(creationDeadline.toString()),[...Buffer.from(createSig.slice(2),"hex")]).accountsStrict({payer:payer.publicKey,evmVault:safe,usdcMint:mint,vaultUsdcAta:ata,tokenProgram:TOKEN_PROGRAM_ID,associatedTokenProgram:ASSOCIATED_TOKEN_PROGRAM_ID,systemProgram:SystemProgram.programId}).instruction();
  const badSponsorSig=await account.signTypedData(lifecycleTypedData(safe,1n,creationDeadline,otherController.publicKey));
  const badCreate=await program.methods.createEvmSafeAuthorized([...ownerBytes],new BN(1),new BN(creationDeadline.toString()),[...Buffer.from(badSponsorSig.slice(2),"hex")]).accountsStrict({payer:payer.publicKey,evmVault:safe,usdcMint:mint,vaultUsdcAta:ata,tokenProgram:TOKEN_PROGRAM_ID,associatedTokenProgram:ASSOCIATED_TOKEN_PROGRAM_ID,systemProgram:SystemProgram.programId}).instruction();
  assert.notEqual((await connection.simulateTransaction((await transaction([badCreate])).tx)).value.err,null,"sponsor substitution must fail");
  assert.equal(await connection.getAccountInfo(safe),null);
  const secondSig=await secondAccount.signTypedData(lifecycleTypedData(second.safe,1n,creationDeadline,payer.publicKey));
  const secondCreate=await program.methods.createEvmSafeAuthorized([...second.ownerBytes],new BN(1),new BN(creationDeadline.toString()),[...Buffer.from(secondSig.slice(2),"hex")]).accountsStrict({payer:payer.publicKey,evmVault:second.safe,usdcMint:mint,vaultUsdcAta:second.ata,tokenProgram:TOKEN_PROGRAM_ID,associatedTokenProgram:ASSOCIATED_TOKEN_PROGRAM_ID,systemProgram:SystemProgram.programId}).instruction();
  await send([create,secondCreate]);
  await send([createAssociatedTokenAccountInstruction(payer.publicKey,source,payer.publicKey,mint),createAssociatedTokenAccountInstruction(payer.publicKey,recipient,controller.publicKey,mint),createAssociatedTokenAccountInstruction(payer.publicKey,alternative,otherController.publicKey,mint),createMintToInstruction(mint,source,payer.publicKey,1_000_000n),createMintToInstruction(mint,second.ata,payer.publicKey,1_000_000n)]);
  const deposit=await send([createTransferCheckedInstruction(source,mint,ata,payer.publicKey,1_000_000n,6)]);
  assert.deepEqual(await balances(),[1_000_000n,0n,"1"]);
  let deadline=BigInt(Math.floor(Date.now()/1000)+600),nonce=2n,amount=100_000n;
  const typed=withdrawalTypedData(safe,mint,amount,recipient,controller.publicKey,nonce,deadline),signature=await account.signTypedData(typed);
  await deny("amount_substitution",await withdrawIx(amount+1n,nonce,deadline,signature));
  await deny("recipient_substitution",await withdrawIx(amount,nonce,deadline,signature,{recipientUsdcAccount:alternative}));
  await deny("mint_substitution",await withdrawIx(amount,nonce,deadline,signature,{usdcMint:wrongMint}));
  await deny("safe_substitution",await withdrawIx(amount,nonce,deadline,signature,{evmVault:second.safe,vaultUsdcAta:second.ata}));
  await deny("wrong_token_program",await withdrawIx(amount,nonce,deadline,signature,{tokenProgram:SystemProgram.programId}));
  await deny("noncanonical_source",await withdrawIx(amount,nonce,deadline,signature,{vaultUsdcAta:source}));
  await deny("legacy_withdraw_rejects_evm_account", await legacyProgram.methods.withdraw(new BN(amount.toString())).accountsStrict({owner:payer.publicKey,vault:safe,usdcMint:mint,ownerUsdcAta:source,vaultUsdcAta:ata,tokenProgram:TOKEN_PROGRAM_ID}).instruction());
  await deny("legacy_executor_cpi_rejects_evm_account",await legacyProgram.methods.executeProtocolCpi(Buffer.alloc(0)).accountsStrict({authority:payer.publicKey,vault:safe}).instruction());
  await deny("missing_owner_intent",await withdrawIx(amount,nonce,deadline,"0x"+"00".repeat(65)));
  const alien=privateKeyToAccount("0x"+randomBytes(32).toString("hex"));
  await deny("wrong_evm_owner",await withdrawIx(amount,nonce,deadline,await alien.signTypedData(typed)));
  await deny("wrong_cluster",await withdrawIx(amount,nonce,deadline,await account.signTypedData({...typed,message:{...typed.message,genesisHash:"0x"+"11".repeat(32)}})));
  await deny("wrong_program_domain",await withdrawIx(amount,nonce,deadline,await account.signTypedData({...typed,domain:{...typed.domain,salt:bytesToHex(SystemProgram.programId.toBytes())}})));
  await deny("allocation_is_not_withdrawal",await withdrawIx(amount,nonce,deadline,await account.signTypedData(allocationTypedData(safe,[5000,0,0,0,0,0,0,0],nonce,deadline))));
  await deny("high_s",await withdrawIx(amount,nonce,deadline,highS(signature)));
  await deny("invalid_recovery_byte",await withdrawIx(amount,nonce,deadline,signature.slice(0,130)+"1d"));
  const expired=1n;
  await deny("expiry",await withdrawIx(amount,nonce,expired,await account.signTypedData(withdrawalTypedData(safe,mint,amount,recipient,controller.publicKey,nonce,expired))));
  await deny("nonce_skip",await withdrawIx(amount,3n,deadline,await account.signTypedData(withdrawalTypedData(safe,mint,amount,recipient,controller.publicKey,3n,deadline))));
  await deny("zero_amount",await withdrawIx(0n,nonce,deadline,signature));
  await deny("insufficient_balance",await withdrawIx(1_000_001n,nonce,deadline,await account.signTypedData(withdrawalTypedData(safe,mint,1_000_001n,recipient,controller.publicKey,nonce,deadline))));
  await deny("self_transfer",await withdrawIx(amount,nonce,deadline,signature,{recipientUsdcAccount:ata}));
  // The account address stays identical, but its controlling Solana owner changes.
  await send([createSetAuthorityInstruction(recipient,controller.publicKey,AuthorityType.AccountOwner,otherController.publicKey)],[payer,controller]);
  await deny("recipient_authority_changed",await withdrawIx(amount,nonce,deadline,signature));
  await send([createSetAuthorityInstruction(recipient,otherController.publicKey,AuthorityType.AccountOwner,controller.publicKey)],[payer,otherController]);
  await send([createFreezeAccountInstruction(recipient,mint,payer.publicKey)]);
  await deny("frozen_recipient_cpi_failure_preserves_nonce",await withdrawIx(amount,nonce,deadline,signature));
  await send([createThawAccountInstruction(recipient,mint,payer.publicKey)]);
  const partial=await send([await withdrawIx(amount,nonce,deadline,signature)]);
  assert.deepEqual(await balances(),[900_000n,100_000n,"2"]);
  await deny("withdraw_replay",await withdrawIx(amount,nonce,deadline,signature));
  const allocation=await account.signTypedData(allocationTypedData(safe,[5000,0,0,0,0,0,0,0],2n,deadline));
  await deny("allocation_replay_after_withdraw",await program.methods.evmSetAllocation([5000,0,0,0,0,0,0,0],new BN(2),new BN(deadline.toString()),[...Buffer.from(allocation.slice(2),"hex")]).accountsStrict({payer:payer.publicKey,evmVault:safe}).instruction());
  const nextAlloc=await account.signTypedData(allocationTypedData(safe,[5000,0,0,0,0,0,0,0],3n,deadline));
  await send([await program.methods.evmSetAllocation([5000,0,0,0,0,0,0,0],new BN(3),new BN(deadline.toString()),[...Buffer.from(nextAlloc.slice(2),"hex")]).accountsStrict({payer:payer.publicKey,evmVault:safe}).instruction()]);
  const stale=await account.signTypedData(withdrawalTypedData(safe,mint,900000n,recipient,controller.publicKey,3n,deadline));
  await deny("withdraw_replay_after_allocation",await withdrawIx(900000n,3n,deadline,stale));
  nonce=4n;amount=900000n;const finalSig=await account.signTypedData(withdrawalTypedData(safe,mint,amount,recipient,controller.publicKey,nonce,deadline));
  await confirm(await connection.requestAirdrop(alternatePayer.publicKey,100_000_000));
  // This isolated validator runs the Devnet-feature binary. Only this test adapter supplies its compiled domain; production RPC genesis verification stays strict.
  const {RelayerWorker,publicJob}=await import("../../client/src/v2EvmRelayerService.ts"),{RelayJournal}=await import("../../client/src/v2EvmRelayJournal.ts");
  const localRpc=new Proxy(connection,{get(target,key){if(key==="getGenesisHash")return async()=>mod.exports.EVM_DEVNET_GENESIS;const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}});
  const relayPolicy={payer:alternatePayer.publicKey.toBase58(),sendEnabled:true,automatic:false,allowLifecycle:true,expectedElfBytes:readFileSync(binary).length,expectedElfSha256:createHash("sha256").update(readFileSync(binary)).digest("hex"),allowedOwners:[account.address],maxFeeLamports:5000,maxRentLamports:10000000,maxDailyLamports:20000000,maxHourlyTransactions:10,minBalanceLamports:10000000};
  const journal=new RelayJournal(join(scratch,"relayer.jsonl")),worker=new RelayerWorker(relayPolicy,localRpc,alternatePayer,journal);
  const recoveryIntent={action:"withdraw_usdc",cluster:"devnet",program:programId.toBase58(),genesisHash:mod.exports.EVM_DEVNET_GENESIS,owner:account.address,safe:safe.toBase58(),mint:mint.toBase58(),amountRaw:amount.toString(),recipientTokenAccount:recipient.toBase58(),recipientOwner:controller.publicKey.toBase58(),nonce:nonce.toString(),deadline:deadline.toString(),signature:finalSig};
  const quote=await worker.enqueue(recoveryIntent);assert.equal(quote.state,"quoted");assert.equal(quote.plan.feeLamports,5000);assert.equal(quote.plan.rentLamports,0);
  const submitted=await worker.approve(quote.id,quote.planHash);assert.equal(submitted.state,"submitted");await confirm(submitted.signature);
  for(let n=0;n<400 && journal.get(quote.id).state!=="finalized";n++){await worker.reconcile();await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(journal.get(quote.id).state,"finalized");assert.equal(journal.get(quote.id).actualCostLamports,5000);
  journal.close();const restartedJournal=new RelayJournal(join(scratch,"relayer.jsonl"));assert.equal(restartedJournal.get(quote.id).state,"finalized");restartedJournal.close();
  const full={signature:submitted.signature,computeUnits:quote.plan.computeUnits,relayerJournalVerified:true};
  assert.deepEqual(await balances(),[0n,1_000_000n,"4"]);
  await send([createMintToInstruction(mint,ata,payer.publicKey,1000n)]);
  const pendingSignature=await account.signTypedData(withdrawalTypedData(safe,mint,1000n,recipient,controller.publicKey,5n,deadline));
  const cancelSig=await account.signTypedData(lifecycleTypedData(safe,5n,deadline));
  const cancelIx=await program.methods.evmCancelIntents(new BN(5),new BN(deadline.toString()),[...Buffer.from(cancelSig.slice(2),"hex")]).accountsStrict({payer:alternatePayer.publicKey,evmVault:safe}).instruction();
  const cancellation=await send([cancelIx],[alternatePayer],alternatePayer.publicKey);
  assert.deepEqual(await balances(),[1000n,1_000_000n,"5"]);
  await deny("cancelled_withdrawal_rejected",await withdrawIx(1000n,5n,deadline,pendingSignature));
  await deny("cancellation_replay",await program.methods.evmCancelIntents(new BN(5),new BN(deadline.toString()),[...Buffer.from(cancelSig.slice(2),"hex")]).accountsStrict({payer:payer.publicKey,evmVault:safe}).instruction());
  await deny("withdrawal_signature_cannot_cancel",await program.methods.evmCancelIntents(new BN(6),new BN(deadline.toString()),[...Buffer.from(pendingSignature.slice(2),"hex")]).accountsStrict({payer:payer.publicKey,evmVault:safe}).instruction());
  const recoveryAfterCancel=await send([await withdrawIx(1000n,6n,deadline,await account.signTypedData(withdrawalTypedData(safe,mint,1000n,recipient,controller.publicKey,6n,deadline)),{payer:alternatePayer.publicKey})],[alternatePayer],alternatePayer.publicKey);
  assert.deepEqual(await balances(),[0n,1_001_000n,"6"]);
  const last=await state();assert(last.rentPayer.equals(payer.publicKey));assert.equal((await connection.getAccountInfo(safe)).data.length,705);
  console.log(JSON.stringify({status:"passed",cluster:"localnet",binarySHA256:createHash("sha256").update(readFileSync(binary)).digest("hex"),evmOwner:account.address,safe:safe.toBase58(),source:ata.toBase58(),recipient:recipient.toBase58(),deposit,partial,full,cancellation,recoveryAfterCancel,alternatePayer:alternatePayer.publicKey.toBase58(),unsignedCreationRejected:true,sponsorSubstitutionRejected:true,finalSourceRaw:"0",finalRecipientRaw:"1001000",finalNonce:"6",rejectedCount:rejected.length,rejected,scratch}));
} finally {
  validator.kill("SIGTERM");
  await Promise.race([new Promise(resolve=>validator.once("exit",resolve)),new Promise(resolve=>setTimeout(resolve,5000))]);
  if(validator.exitCode===null)validator.kill("SIGKILL");closeSync(log);
}
