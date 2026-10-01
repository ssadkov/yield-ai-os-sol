/** Public-only unsigned Devnet transfer quote; no signer or send. */
import assert from "node:assert/strict";
import {Connection,PublicKey,SystemProgram,Transaction,VersionedTransaction} from "@solana/web3.js";
const connection=new Connection(process.env.V2_DEVNET_RPC_URL||"https://api.devnet.solana.com","finalized");
const from=new PublicKey("8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A"),to=new PublicKey("GhK2bfKSsFgVrm6RbgHZkMzQ34pvYh5tGjfda3UchY1s"),lamports=50000000;
assert.equal(await connection.getGenesisHash(),"EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
const [payer,recipient]=await connection.getMultipleAccountsInfo([from,to],"finalized");assert(payer&&payer.owner.equals(SystemProgram.programId));assert(!recipient||recipient.owner.equals(SystemProgram.programId));
const tx=new Transaction({feePayer:from,recentBlockhash:(await connection.getLatestBlockhash("finalized")).blockhash}).add(SystemProgram.transfer({fromPubkey:from,toPubkey:to,lamports}));
const fee=(await connection.getFeeForMessage(tx.compileMessage(),"finalized")).value;assert.equal(fee,5000);assert(payer.lamports>=lamports+fee);
const result=await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()),{sigVerify:false,replaceRecentBlockhash:true,commitment:"finalized",accounts:{encoding:"base64",addresses:[from.toBase58(),to.toBase58()]}});assert.equal(result.value.err,null);assert.equal(result.value.accounts[1].lamports,(recipient?.lamports||0)+lamports);
const packet={status:"unsigned_simulation_ok",observedAt:new Date().toISOString(),cluster:"devnet",action:"fund_separate_relayer",from:from.toBase58(),to:to.toBase58(),amountLamports:lamports,feeLamports:fee,rentLamports:0,payerBeforeLamports:payer.lamports,payerAfterLamports:payer.lamports-lamports-fee,recipientBeforeLamports:recipient?.lamports||0,recipientAfterLamports:(recipient?.lamports||0)+lamports,sendEnabled:false,transactionSent:false,walletFilesRead:false};
console.log(JSON.stringify(packet,null,2));
export {connection,from,to,lamports,tx,fee,packet};
