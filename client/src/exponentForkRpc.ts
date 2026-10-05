/** Loopback, read/simulation-only RPC adapter for bankrun. It exposes no sending method. */
import { createServer } from 'node:http';
import { PublicKey, VersionedTransaction, VersionedMessage } from '@solana/web3.js';
export async function forkRpc(context:any) {
  const account=(a:any)=>a===null?null:{lamports:a.lamports,owner:a.owner.toBase58(),executable:a.executable,rentEpoch:0,data:[Buffer.from(a.data).toString('base64'),'base64']};
  const server=createServer(async (req,res)=>{
    let requestId:unknown=null;
    try {
      let body='';for await(const part of req)body+=part;if(body.length>100000)throw Error('oversized');
      const call=JSON.parse(body),args=call.params??[],bank=context.banksClient,clock=await bank.getClock();requestId=call.id;
      const slot=Number(clock.slot);let result:unknown;
      switch(call.method) {
        case 'getAccountInfo':result={context:{slot},value:account(await bank.getAccount(new PublicKey(args[0])))};break;
        case 'getMultipleAccounts':result={context:{slot},value:await Promise.all(args[0].map(async(k:string)=>account(await bank.getAccount(new PublicKey(k)))))};break;
        case 'getBalance':result={context:{slot},value:(await bank.getAccount(new PublicKey(args[0])))?.lamports??0};break;
        case 'getSlot':result=slot;break;
        case 'getEpochInfo':result={epoch:Number(clock.epoch),slotIndex:slot%432000,slotsInEpoch:432000,absoluteSlot:slot,blockHeight:Number(await bank.getBlockHeight())};break;
        case 'getBlockTime':result=Number(clock.unixTimestamp);break;
        case 'getBlockHeight':result=Number(await bank.getBlockHeight());break;
        case 'getLatestBlockhash':{const h=await bank.getLatestBlockhash();if(!h)throw Error('no blockhash');result={context:{slot},value:{blockhash:h[0],lastValidBlockHeight:Number(h[1])}};break;}
        case 'getMinimumBalanceForRentExemption':result=Number((await bank.getRent()).minimumBalance(BigInt(args[0])));break;
        case 'getGenesisHash':result='11111111111111111111111111111111';break;
        // This local bank uses the standard 5,000 lamports per signature, including v0 messages.
        case 'getFeeForMessage':result={context:{slot},value:VersionedMessage.deserialize(Buffer.from(args[0],'base64')).header.numRequiredSignatures*5000};break;
        case 'simulateTransaction':{
          const tx=VersionedTransaction.deserialize(Buffer.from(args[0],'base64')),sim=await bank.simulateTransaction(tx);
          result={context:{slot},value:{err:sim.result===null?null:{InstructionError:[0,{Custom:1}]},logs:sim.meta?.logMessages??[],unitsConsumed:Number(sim.meta?.computeUnitsConsumed??0),accounts:null,returnData:null}};break;
        }
        default:throw Error('read-only fork RPC does not expose '+call.method);
      }
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:call.id,result}));
    }catch(error){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:requestId,error:{code:-32603,message:String(error)}}));}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const a=server.address();if(!a||typeof a==='string')throw Error('no loopback port');
  return {url:'http://127.0.0.1:'+a.port,close:()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()))};
}
