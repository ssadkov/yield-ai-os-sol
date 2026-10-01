/** Devnet Squads creation only. Protected WSL operator; no upgrade authority transfer. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, openSync, closeSync, fsyncSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import * as squads from "@sqds/multisig";
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { createRequire } from "node:module";
const bs58 = createRequire(import.meta.url)("bs58") as { encode(bytes: Uint8Array): string };
import { GOVERNANCE_MEMBERS, GOVERNANCE_TIMELOCK, SQUADS_PROGRAM, OPERATOR, RELAYER, validateGovernance } from "./v2EvmGovernancePolicy.ts";

async function main() {
const mode=process.argv[2];
assert(["--prepare","--send-reviewed","--verify"].includes(mode), "Use --prepare, --send-reviewed or --verify");
assert(mode==="--verify"||process.platform==="linux","Protected WSL operator runtime required for preparation/signing");
const directory="/home/sergei/.config/yield-ai-v2/evm-devnet-governance", createPath=directory+"/create-key.json", journalPath=directory+"/create-journal.json";
const output=new URL("../../docs/yield-ai-v2-evm-governance-create-",import.meta.url);
const preflightPath=new URL(output.href+"preflight.json"), resultPath=new URL(output.href+"result.json");
const connection=new Connection(process.env.V2_DEVNET_RPC_URL||"https://api.devnet.solana.com","finalized");
assert.equal(new URL(connection.rpcEndpoint).protocol,"https:");
assert.equal(await connection.getGenesisHash(),"EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
const loader=new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"), program=new PublicKey("8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5");
const [programData]=PublicKey.findProgramAddressSync([program.toBuffer()],loader);
const [squadsData]=PublicKey.findProgramAddressSync([SQUADS_PROGRAM.toBuffer()],loader);
const [squadProgram,squadPd,yieldProgram,yieldPd]=await connection.getMultipleAccountsInfo([SQUADS_PROGRAM,squadsData,program,programData],"finalized");
assert(squadProgram?.executable&&squadProgram.owner.equals(loader)&&squadProgram.data.readUInt32LE()===2&&new PublicKey(squadProgram.data.subarray(4)).equals(squadsData));
assert(squadPd&&squadPd.owner.equals(loader)&&squadPd.data.readUInt32LE()===3);
assert(yieldProgram?.executable&&yieldProgram.owner.equals(loader)&&new PublicKey(yieldProgram.data.subarray(4)).equals(programData));
assert(yieldPd&&yieldPd.owner.equals(loader)&&yieldPd.data.length===699149&&yieldPd.data.readUInt32LE()===3&&yieldPd.data[12]===1&&new PublicKey(yieldPd.data.subarray(13,45)).equals(OPERATOR));
const elfHash=createHash("sha256").update(yieldPd.data.subarray(45,45+695488)).digest("hex");
assert.equal(elfHash,"4a2a277a6df06bbcafe172f90ff88bfc3d31fe34b4309b2b6913a4d7b70fdf98");
assert(yieldPd.data.subarray(45+695488).every(n=>n===0));
const squadCodeHash=createHash("sha256").update(squadPd.data.subarray(45)).digest("hex");
if(mode==="--prepare") {
 mkdirSync(directory,{recursive:true,mode:0o700});assert.equal(statSync(directory).mode&0o077,0);
 if(!existsSync(createPath)) { const k=Keypair.generate();writeFileSync(createPath,JSON.stringify([...k.secretKey]),{flag:"wx",mode:0o600});k.secretKey.fill(0); }
}
if(mode!=="--verify")assert.equal(statSync(createPath).mode&0o077,0);
const createKey=mode==="--verify"?{publicKey:new PublicKey(JSON.parse(readFileSync(preflightPath,"utf8")).createKey),secretKey:new Uint8Array()}:loadCreateKey();
function loadCreateKey(){const raw=Uint8Array.from(JSON.parse(readFileSync(createPath,"utf8"))),key=Keypair.fromSecretKey(Uint8Array.from(raw));raw.fill(0);return key;}
const [multisig]=squads.getMultisigPda({createKey:createKey.publicKey}),[vault]=squads.getVaultPda({multisigPda:multisig,index:0});
const publicBase={cluster:"devnet",squadsProgram:SQUADS_PROGRAM.toBase58(),squadsProgramData:squadsData.toBase58(),squadsProgramDataSha256:squadCodeHash,multisig:multisig.toBase58(),vault:vault.toBase58(),createKey:createKey.publicKey.toBase58(),members:GOVERNANCE_MEMBERS,threshold:2,timeLockSeconds:GOVERNANCE_TIMELOCK,configAuthority:PublicKey.default.toBase58(),feePayer:OPERATOR.toBase58(),yieldProgram:program.toBase58(),yieldUpgradeAuthority:OPERATOR.toBase58(),yieldElfSha256:elfHash,relayerExcluded:true,authorityTransferred:false};
try {
 const existing=await connection.getAccountInfo(multisig,"finalized");
 if(mode==="--verify") {
  assert(existing);assert.equal(JSON.parse(readFileSync(preflightPath,"utf8")).squadsProgramDataSha256,squadCodeHash,"Squads binary changed since creation preflight");const validated=validateGovernance(existing,multisig);assert(validated.vault.equals(vault));
  const reviewed=JSON.parse(readFileSync(preflightPath,"utf8"));
  const pc=await connection.getAccountInfo(squads.getProgramConfigPda({})[0],"finalized");assert(pc&&pc.owner.equals(SQUADS_PROGRAM));
  const [programConfig]=squads.accounts.ProgramConfig.fromAccountInfo(pc);
  const expected=squads.instructions.multisigCreateV2({treasury:programConfig.treasury,creator:OPERATOR,multisigPda:multisig,configAuthority:null,threshold:2,members:GOVERNANCE_MEMBERS.map(key=>({key:new PublicKey(key),permissions:squads.types.Permissions.all()})),timeLock:GOVERNANCE_TIMELOCK,createKey:createKey.publicKey,rentCollector:null});
  assert(process.argv[3]||process.platform==="linux","public verification signature required");
  const journal={...reviewed,signature:process.argv[3]||JSON.parse(readFileSync(journalPath,"utf8")).signature,instructionData:expected.data.toString("base64"),instructionAccounts:expected.keys.map(k=>k.pubkey.toBase58())};
  assert(journal.signature);const receipt=await connection.getTransaction(journal.signature,{commitment:"finalized",maxSupportedTransactionVersion:0});
  assert(receipt?.meta&&!receipt.meta.err);
  const keys=receipt.transaction.message.getAccountKeys();assert.equal(keys.get(0)?.toBase58(),OPERATOR.toBase58());
  assert.equal(receipt.transaction.message.compiledInstructions.length,1);
  const actualInstruction=receipt.transaction.message.compiledInstructions[0];
  assert.equal(keys.get(actualInstruction.programIdIndex)?.toBase58(),SQUADS_PROGRAM.toBase58());
  assert(Buffer.from(actualInstruction.data).equals(Buffer.from(journal.instructionData,"base64")));
  assert.deepEqual(actualInstruction.accountKeyIndexes.map(i=>keys.get(i)?.toBase58()),journal.instructionAccounts);
  const debit=receipt.meta.preBalances[0]-receipt.meta.postBalances[0];
  assert(debit<=journal.maxCostLamports&&receipt.meta.fee===journal.feeLamports);
  const result={...publicBase,status:"devnet_multisig_creation_finalized_verified",signature:journal.signature,slot:receipt.slot,feeLamports:receipt.meta.fee,totalOperatorDebitLamports:debit,creationFeeLamports:journal.creationFeeLamports,rentLamports:journal.rentLamports,multisigTransactionIndex:validated.config.transactionIndex.toString(),signerFilesRead:false,verifiedAt:new Date().toISOString()};
  writeFileSync(resultPath,JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify(result));return;
 }
 assert(!existing,"Multisig already exists; use --verify, never recreate blindly");
 assert(!existsSync(journalPath),"Prior creation journal exists; inspect signature before any send");
 const [configAddress]=squads.getProgramConfigPda({}),configInfo=await connection.getAccountInfo(configAddress,"finalized");
 assert(configInfo&&configInfo.owner.equals(SQUADS_PROGRAM)&&configInfo.data.subarray(0,8).equals(Buffer.from(squads.accounts.programConfigDiscriminator)));
 const [config]=squads.accounts.ProgramConfig.fromAccountInfo(configInfo);
 const instruction=squads.instructions.multisigCreateV2({treasury:config.treasury,creator:OPERATOR,multisigPda:multisig,configAuthority:null,threshold:2,members:GOVERNANCE_MEMBERS.map(key=>({key:new PublicKey(key),permissions:squads.types.Permissions.all()})),timeLock:GOVERNANCE_TIMELOCK,createKey:createKey.publicKey,rentCollector:null});
 const block=await connection.getLatestBlockhash("confirmed"),tx=new Transaction({feePayer:OPERATOR,recentBlockhash:block.blockhash}).add(instruction);
 const fee=(await connection.getFeeForMessage(tx.compileMessage(),"confirmed")).value;assert.equal(fee,10000);
 const before=await connection.getBalance(OPERATOR,"confirmed");
 const sim=(await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()),{sigVerify:false,replaceRecentBlockhash:true,commitment:"confirmed",accounts:{encoding:"base64",addresses:[OPERATOR.toBase58(),multisig.toBase58(),config.treasury.toBase58()]}})).value;
 assert.equal(sim.err,null);assert(sim.accounts?.[0]&&sim.accounts[1]);
 const simulated=sim.accounts[1],created={owner:new PublicKey(simulated.owner),executable:simulated.executable,data:Buffer.from(simulated.data[0],"base64")};
 validateGovernance(created,multisig);
 const creationFee=Number(config.multisigCreationFee.toString());assert(Number.isSafeInteger(creationFee)&&creationFee>=0);
 const rent=simulated.lamports,debit=before-sim.accounts[0].lamports;assert.equal(debit,fee+rent+creationFee);assert(debit<=200000000&&before-debit>=1000000000);
 const plan={...publicBase,status:"devnet_multisig_create_preflight_ok",feeLamports:fee,rentLamports:rent,creationFeeLamports:creationFee,totalOperatorDebitLamports:debit,maxCostLamports:200000000,computeUnits:sim.unitsConsumed};
 if(mode==="--prepare"){writeFileSync(preflightPath,JSON.stringify(plan,null,2)+"\n");console.log(JSON.stringify(plan));return;}
 assert.equal(process.env.V2_EVM_GOVERNANCE_ACK,"DEVNET_SQUADS_2_OF_3_ONE_HOUR_CREATE_ONLY");
 assert.deepEqual(plan,JSON.parse(readFileSync(preflightPath,"utf8")),"Public preflight changed; prepare and review again");
 assert.equal(process.env.V2_PAYER_KEYPAIR,"/home/sergei/.config/solana/id.json");
 const operatorBytes=Uint8Array.from(JSON.parse(readFileSync(process.env.V2_PAYER_KEYPAIR,"utf8"))),operator=Keypair.fromSecretKey(Uint8Array.from(operatorBytes));operatorBytes.fill(0);
 try {
  assert(operator.publicKey.equals(OPERATOR)&&!operator.publicKey.equals(RELAYER));tx.sign(operator,createKey);
  const wire=tx.serialize(),signature=bs58.encode(tx.signature!);
  const signed=(await connection.simulateTransaction(VersionedTransaction.deserialize(wire),{sigVerify:true,commitment:"confirmed"})).value;assert.equal(signed.err,null);
  const journal={...plan,signature,status:"prepared",wireBase64:wire.toString("base64"),lastValidBlockHeight:block.lastValidBlockHeight,instructionData:instruction.data.toString("base64"),instructionAccounts:instruction.keys.map(k=>k.pubkey.toBase58())};
  function save(){const fd=openSync(journalPath+".tmp","w",0o600);try{writeFileSync(fd,JSON.stringify(journal));fsyncSync(fd);}finally{closeSync(fd);}renameSync(journalPath+".tmp",journalPath);const dir=openSync(dirname(journalPath),"r");try{fsyncSync(dir);}finally{closeSync(dir);}}
  save();console.log(JSON.stringify({...plan,status:"signed_simulation_passed",signature}));
  const returned=await connection.sendRawTransaction(wire,{skipPreflight:false,preflightCommitment:"confirmed",maxRetries:2});assert.equal(returned,signature);journal.status="submitted";save();
  const confirmation=await connection.confirmTransaction({signature,...block},"finalized");assert.equal(confirmation.value.err,null);journal.status="finalized";save();console.log(JSON.stringify({status:"creation_finalized_use_verify",signature,multisig:multisig.toBase58()}));
 } finally {operator.secretKey.fill(0);}
} finally {createKey.secretKey.fill(0);}
}
await main();
