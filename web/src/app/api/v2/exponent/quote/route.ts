import { NextResponse } from 'next/server';
import { quote } from '@/server/exponent/adapter';
import { rpc, parseRequest, unavailable } from '@/server/exponent/http';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request) {
  const params=new URL(request.url).searchParams;
  const values:Record<string,unknown>=Object.fromEntries(params);
  if(params.has('slippageBps'))values.slippageBps=Number(params.get('slippageBps'));
  let input;try{input=parseRequest(values);}catch{return NextResponse.json({error:'action=buy|sell|redeem; amount=positive raw integer; slippageBps=2..100'},{status:400});}
  try{return NextResponse.json((await quote(rpc(),input)).public,{headers:{'Cache-Control':'no-store'}});}
  catch{return unavailable();}
}
