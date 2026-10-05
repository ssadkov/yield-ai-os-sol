import { Connection } from '@solana/web3.js';
import { NextResponse } from 'next/server';
import { V2_MAINNET_RPC_URL, v2MainnetRpcHeaders } from '../../lib/v2MainnetRpc.server';
import { rawAmount, type ExponentAction } from '../../lib/exponentV2';
import type { QuoteRequest } from './adapter';
export function rpc() {
  return new Connection(V2_MAINNET_RPC_URL,{commitment:'confirmed',httpHeaders:v2MainnetRpcHeaders(),
    fetch:async (url,options)=>fetch(url,{...options,signal:AbortSignal.timeout(20_000)})});
}
export function parseRequest(value:Record<string,unknown>):QuoteRequest {
  if(!['buy','sell','redeem'].includes(String(value.action)))throw Error('invalid action');
  rawAmount(value.amount);
  for(const key of ['owner','authority','market'])if(value[key]!==undefined&&typeof value[key]!=='string')throw Error('invalid '+key);
  if(value.asset!==undefined&&value.asset!=='USDC'&&value.asset!=='ONYC')throw Error('invalid asset');
  if(value.slippageBps!==undefined&&(!Number.isInteger(value.slippageBps)||Number(value.slippageBps)<2||Number(value.slippageBps)>100))throw Error('slippageBps must be 2..100');
  return {action:value.action as ExponentAction,amount:value.amount as string,owner:value.owner as string|undefined,
    authority:value.authority as string|undefined,market:value.market as string|undefined,asset:value.asset as 'USDC'|'ONYC'|undefined,
    slippageBps:value.slippageBps as number|undefined};
}
export function unavailable() {
  // Never send provider URLs, credentials, or SDK exception objects to callers.
  return NextResponse.json({error:'Current market, quote, position or simulation is unavailable. Check input, setup and policy; retry with a fresh quote.',code:'EXPONENT_UNAVAILABLE'},{status:422,headers:{'Cache-Control':'no-store'}});
}
