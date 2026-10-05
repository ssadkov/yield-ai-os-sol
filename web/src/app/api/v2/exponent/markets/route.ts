import { NextResponse } from 'next/server';
import { marketInfo } from '@/server/exponent/adapter';
import { rpc, unavailable } from '@/server/exponent/http';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET() {
  try{return NextResponse.json({markets:[await marketInfo(rpc())]},{headers:{'Cache-Control':'no-store'}});}
  catch{return unavailable();}
}
