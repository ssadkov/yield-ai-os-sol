/** Local operator HTTP client. Web code never receives the admin credential. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {loadRelayConfig} from "./v2EvmRelayerService.ts";
import {parseEvmOwnerIntent,verifyEvmIntentSignature} from "../../web/src/lib/v2EvmDevnet.ts";
const [mode,configPath,arg,planHash]=process.argv.slice(2);
assert(["--quote","--status","--approve"].includes(mode)&&configPath&&arg,"Use --quote <protected-config> <intent.json>, --status <config> <digest>, or --approve <config> <digest> <reviewed-plan-hash>");
const config=loadRelayConfig(configPath),base="http://127.0.0.1:"+config.port;
let digest=arg,body: unknown,path="/jobs/"+arg,method="GET",token=config.submitToken;
if(mode==="--quote") {const intent=parseEvmOwnerIntent(JSON.parse(readFileSync(arg,"utf8")));digest=await verifyEvmIntentSignature(intent);body=intent;path="/jobs";method="POST";}
else assert(/^0x[0-9a-f]{64}$/.test(arg),"invalid job digest");
if(mode==="--approve") {
 assert.equal(process.env.V2_EVM_RELAYER_SEND_ACK,"APPROVED_DEVNET_JOB","Each Devnet send needs exact-operation approval");
 assert(planHash&&/^[0-9a-f]{64}$/.test(planHash),"invalid reviewed plan hash");body={planHash};path+="/approve";method="POST";token=config.adminToken;
}
const response=await fetch(base+path,{method,headers:{authorization:"Bearer "+token,"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{}),redirect:"error",signal:AbortSignal.timeout(30000)});
const result=await response.json() as {id?:string;error?:string;state?:string;planHash?:string;plan?:Record<string,unknown>;signature?:string;slot?:number;actualCostLamports?:number};
assert(response.ok,"Local relayer rejected operation; inspect public job status");assert.equal(result.id,digest,"relayer job digest mismatch");
console.log(JSON.stringify({id:result.id,state:result.state,planHash:result.planHash,plan:result.plan,signature:result.signature,slot:result.slot,actualCostLamports:result.actualCostLamports}));
