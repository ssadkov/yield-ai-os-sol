import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { EXPONENT } from '../src/lib/exponentV2.ts';
import { checkedOrcaTickArray, checkedOrcaTickArrays } from '../src/lib/exponentOrca.ts';
const pool=new PublicKey(EXPONENT.whirlpool),program=new PublicKey(EXPONENT.orcaProgram);
function fixture(dynamic=false,bitmap=0n,start=-67672){
 const size=dynamic?148+[...Array(88).keys()].filter(i=>bitmap&(1n<<BigInt(i))).length*112:9988;
 const data=Buffer.alloc(size);
 Buffer.from(dynamic?[17,216,246,142,225,199,218,56]:[69,97,189,190,110,7,66,187]).copy(data);
 data.writeInt32LE(start,8);pool.toBuffer().copy(data,dynamic?12:9956);
 if(dynamic){data.writeBigUInt64LE(bitmap&((1n<<64n)-1n),44);data.writeBigUInt64LE(bitmap>>64n,52);
   let offset=60;for(let i=0;i<88;i++){const initialized=Number((bitmap>>BigInt(i))&1n);data[offset]=initialized;offset+=1+initialized*112;}}
 return {address:PublicKey.findProgramAddressSync([Buffer.from('tick_array'),pool.toBuffer(),Buffer.from(String(start))],program)[0],info:{data,owner:program,executable:false,lamports:1,rentEpoch:0}};
}
test('static arrays remain compatible; dynamic ABI requires a reviewed supporting deployment',()=>{
 const old=fixture();assert.equal(checkedOrcaTickArray(old.address,old.info,false).format,'fixed');
 for(const bits of [0n,1n,1n<<87n,(1n<<88n)-1n]){
   const f=fixture(true,bits);assert.equal(checkedOrcaTickArray(f.address,f.info,true).format,'dynamic');
   assert.throws(()=>checkedOrcaTickArray(f.address,f.info,false),e=>e.code==='EXPONENT_UPGRADE_REQUIRED');
 }
});
test('Orca owner, pool, canonical PDA, discriminator and aligned start are mandatory',()=>{
 for(const dynamic of [false,true]){
  const f=fixture(dynamic);assert.throws(()=>checkedOrcaTickArray(PublicKey.default,f.info,true));
  assert.throws(()=>checkedOrcaTickArray(f.address,{...f.info,owner:PublicKey.default},true));
  assert.throws(()=>checkedOrcaTickArray(f.address,{...f.info,executable:true},true));
  for(const offset of [0,8,dynamic?12:9956]){const data=Buffer.from(f.info.data);data[offset]^=1;assert.throws(()=>checkedOrcaTickArray(f.address,{...f.info,data},true));}
  assert.throws(()=>checkedOrcaTickArray(f.address,null,true));
 }
});
test('malformed dynamic bitmap, enum tag and allocation never pass validation',()=>{
 const f=fixture(true,1n);
 for(const modify of [d=>d[60]=0,d=>d[60]=2,d=>d.writeBigUInt64LE(1n<<24n,52)]){
  const data=Buffer.from(f.info.data);modify(data);assert.throws(()=>checkedOrcaTickArray(f.address,{...f.info,data},true));
 }
 for(const len of [0,8,11,147,149,259,10005]){assert.throws(()=>checkedOrcaTickArray(f.address,{...f.info,data:(()=>{const d=Buffer.alloc(len);f.info.data.copy(d);return d;})()},true));}
});
test('active static ranges can change without trusting a single historical address',()=>{
 for(const start of [-67760,-67672,-67584]){const f=fixture(false,0n,start);assert.equal(checkedOrcaTickArray(f.address,f.info,false).startTickIndex,start);}
});
test('RPC-selected arrays are all validated including repeated slots',async()=>{
 const a=fixture(),b=fixture(true,1n,-67584);
 const connection={getMultipleAccountsInfo:async keys=>keys.map(k=>k.equals(a.address)?a.info:b.info)};
 assert.equal((await checkedOrcaTickArrays(connection,[a.address,b.address,b.address],true)).length,3);
 await assert.rejects(()=>checkedOrcaTickArrays(connection,[a.address,b.address,b.address],false),e=>e.code==='EXPONENT_UPGRADE_REQUIRED');
});

