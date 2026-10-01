import { NextResponse } from 'next/server';
import { PublicKey } from '@solana/web3.js';
import { unsignedSetup, unsignedTransaction, unsignedOnycTransfer } from '@/server/exponent/transactions';
import { rpc, parseRequest, unavailable } from '@/server/exponent/http';
import { rawAmount } from '@/lib/exponentV2';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request:Request) {
  let body:Record<string,unknown>;
  try {
    const text=await request.text();if(text.length>4096)throw Error('oversized');
    body=JSON.parse(text);if(!body||Array.isArray(body)||typeof body!=='object')throw Error('invalid object');
    if(typeof body.owner!=='string')throw Error('owner required');new PublicKey(body.owner);
    if(body.action==='deposit_onyc'||body.action==='withdraw_onyc')rawAmount(body.amount);
    else if(body.action!=='setup')parseRequest(body);
    if(body.minimumOutput!==undefined)rawAmount(body.minimumOutput);
    if(body.quotedAt!==undefined&&!Number.isSafeInteger(body.quotedAt))throw Error('invalid quote time');
    if(body.maxLossBps!==undefined&&(!Number.isInteger(body.maxLossBps)||Number(body.maxLossBps)<0||Number(body.maxLossBps)>500))throw Error('invalid loss policy');
  } catch {return NextResponse.json({error:'Invalid transaction request'},{status:400});}
  try {
    const result=body.action==='setup'?await unsignedSetup(rpc(),body.owner as string,body.maxLossBps as number|undefined,body.slippageBps as number|undefined)
      :body.action==='deposit_onyc'||body.action==='withdraw_onyc'
        ?await unsignedOnycTransfer(rpc(),body.owner as string,body.action,body.amount as string)
        :await unsignedTransaction(rpc(),{...parseRequest(body),minimumOutput:body.minimumOutput as string|undefined,quotedAt:body.quotedAt as number|undefined});
    return NextResponse.json(result,{headers:{'Cache-Control':'no-store'}});
  } catch{return unavailable();}
}
