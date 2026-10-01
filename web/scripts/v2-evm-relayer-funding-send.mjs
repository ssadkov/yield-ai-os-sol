/** Exact separately approved Devnet sponsor funding; private signer only in this operator process. */
import assert from "node:assert/strict";
import {readFileSync,writeFileSync,openSync,closeSync,fsyncSync,existsSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {Keypair,VersionedTransaction} from "@solana/web3.js";
import bs58 from "bs58";
assert.equal(process.platform,"linux","Use the protected WSL operator runtime");
assert(process.argv.includes("--send-reviewed")&&process.env.V2_EVM_RELAYER_FUND_ACK==="APPROVED_DEVNET_RELAYER_FUND_005_SOL");
assert.equal(process.env.V2_PAYER_KEYPAIR,"/home/sergei/.config/solana/id.json");
const journalPath=fileURLToPath(new URL("../../target/deploy/evm-relayer-funding-journal.json",import.meta.url));
assert(!existsSync(journalPath),"Funding journal already exists; inspect recorded signature, never repeat blindly");
const {connection,from,to,lamports,tx,fee,packet}=await import("./v2-evm-relayer-funding-preflight.mjs");
assert.equal(lamports,50000000);assert.equal(fee,5000);
const raw=Uint8Array.from(JSON.parse(readFileSync(process.env.V2_PAYER_KEYPAIR,"utf8"))),signer=Keypair.fromSecretKey(Uint8Array.from(raw));raw.fill(0);assert(signer.publicKey.equals(from));
try{
 tx.sign(signer);const wire=tx.serialize(),signature=bs58.encode(tx.signature);
 const sim=await connection.simulateTransaction(VersionedTransaction.deserialize(wire),{sigVerify:true,commitment:"confirmed",accounts:{encoding:"base64",addresses:[from.toBase58(),to.toBase58()]}});assert.equal(sim.value.err,null);assert.equal(sim.value.accounts[1].lamports,packet.recipientAfterLamports);
 const job={...packet,signature,wireBase64:wire.toString("base64"),status:"prepared",walletFilesRead:true,preparedAt:new Date().toISOString()};
 function save(){const fd=openSync(journalPath,"w",0o600);try{writeFileSync(fd,JSON.stringify(job,null,2)+"\n");fsyncSync(fd);}finally{closeSync(fd);}const dir=openSync(fileURLToPath(new URL("../../target/deploy/",import.meta.url)),"r");try{fsyncSync(dir);}finally{closeSync(dir);}}
 save();console.log(JSON.stringify({status:"signed_funding_simulation_ok",cluster:"devnet",signature,amountLamports:lamports,feeLamports:fee,rentLamports:0}));
 assert.equal(await connection.sendRawTransaction(wire,{skipPreflight:false,preflightCommitment:"confirmed",maxRetries:2}),signature);job.status="submitted";job.transactionSent=true;save();
 let finalized;for(let n=0;n<120;n++){const st=(await connection.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];if(st)assert.equal(st.err,null);if(st?.confirmationStatus==="finalized"){finalized=st;break;}await new Promise(resolve=>setTimeout(resolve,500));}
 assert(finalized,"Receipt unresolved; inspect exact signature before any retry");const receipt=await connection.getTransaction(signature,{commitment:"finalized",maxSupportedTransactionVersion:0});assert(receipt&&receipt.meta&&!receipt.meta.err);assert.equal(receipt.meta.fee,fee);
 const keys=receipt.transaction.message.getAccountKeys();assert(keys.get(0).equals(from));let recipientIndex;for(let i=0;i<keys.length;i++)if(keys.get(i).equals(to))recipientIndex=i;assert(Number.isInteger(recipientIndex));assert.equal(receipt.meta.postBalances[recipientIndex]-receipt.meta.preBalances[recipientIndex],lamports);assert.equal(receipt.meta.preBalances[0]-receipt.meta.postBalances[0],lamports+fee);
 Object.assign(job,{status:"funding_finalized_verified",finalizedSlot:receipt.slot,actualFeeLamports:receipt.meta.fee,recipientAfterLamports:receipt.meta.postBalances[recipientIndex],verifiedAt:new Date().toISOString()});save();const {wireBase64,...result}=job;writeFileSync(new URL("../../docs/yield-ai-v2-evm-relayer-funding-result.json",import.meta.url),JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify(result));
}finally{signer.secretKey.fill(0);}
