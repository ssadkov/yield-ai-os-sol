import { Connection, PublicKey, type AccountInfo } from '@solana/web3.js';
import { EXPONENT } from './exponentV2.ts';

export class ExponentRouteUnavailable extends Error {
  readonly code: 'EXPONENT_ROUTE_UNAVAILABLE' | 'EXPONENT_UPGRADE_REQUIRED';
  constructor(code: 'EXPONENT_ROUTE_UNAVAILABLE' | 'EXPONENT_UPGRADE_REQUIRED', message: string) {super(message);this.code=code;}
}
const unavailable=()=>{throw new ExponentRouteUnavailable('EXPONENT_ROUTE_UNAVAILABLE','Orca tick accounts do not match the supported pool, PDA or layout');};
const fixedTag=Buffer.from([69,97,189,190,110,7,66,187]);
const dynamicTag=Buffer.from([17,216,246,142,225,199,218,56]);
export function checkedOrcaTickArray(address:PublicKey,info:AccountInfo<Buffer>|null,allowDynamic:boolean) {
  if(!info || !info.owner.equals(new PublicKey(EXPONENT.orcaProgram)) || info.executable || info.data.length<12)return unavailable();
  const d=info.data,start=d.readInt32LE(8);
  if(start%88!==0||start < -443696||start>443608)return unavailable();
  const canonical=PublicKey.findProgramAddressSync([Buffer.from('tick_array'),new PublicKey(EXPONENT.whirlpool).toBuffer(),Buffer.from(String(start))],new PublicKey(EXPONENT.orcaProgram))[0];
  if(!address.equals(canonical))return unavailable();
  let dynamic=false,poolOffset=9956;
  if(d.subarray(0,8).equals(fixedTag)){if(d.length!==9988)return unavailable();}
  else {
    if(!d.subarray(0,8).equals(dynamicTag)||d.length<148||d.length>10004||(d.length-148)%112!==0)return unavailable();
    dynamic=true;poolOffset=12;
    const bitmap=d.readBigUInt64LE(44)|(d.readBigUInt64LE(52)<<BigInt(64));
    if(bitmap>>BigInt(88))return unavailable();
    let offset=60;
    for(let i=0;i<88;i++){
      const initialized=Number((bitmap>>BigInt(i))&BigInt(1));
      if(offset>=d.length||d[offset]!==initialized)return unavailable();
      offset+=1+initialized*112;if(offset>d.length)return unavailable();
    }
  }
  if(!new PublicKey(d.subarray(poolOffset,poolOffset+32)).equals(new PublicKey(EXPONENT.whirlpool)))return unavailable();
  if(dynamic&&!allowDynamic)throw new ExponentRouteUnavailable('EXPONENT_UPGRADE_REQUIRED','The current Orca range requires DynamicTickArray support in the Safe program; no signing payload issued');
  return {address,startTickIndex:start,format:dynamic?'dynamic':'fixed'};
}
export async function checkedOrcaTickArrays(connection:Connection,keys:PublicKey[],allowDynamic:boolean){
  const infos=await connection.getMultipleAccountsInfo(keys,'confirmed');
  return keys.map((key,i)=>checkedOrcaTickArray(key,infos[i],allowDynamic));
}
