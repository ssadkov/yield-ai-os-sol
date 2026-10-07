import test from 'node:test';
import assert from 'node:assert/strict';
import { createRpcReadFetch } from '../src/lib/rpcReadFetch.ts';
const input='https://rpc.example';
const request=method=>({method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:[]})});
const clock=()=>{let time=0;return {now:()=>time,sleep:async ms=>{time+=ms}};};
test('concurrent reads share paced slots, while a send is not queued or retried',async()=>{
  const c=clock(),calls=[];
  const rpc=createRpcReadFetch(async(_input,init)=>{calls.push({method:JSON.parse(init.body).method,time:c.now()});return new Response('',{status:200});},{...c,intervalMs:200});
  await Promise.all([rpc(input,request('getBalance')),rpc(input,request('getAccountInfo')),rpc(input,request('getGenesisHash'))]);
  assert.deepEqual(calls.map(c=>c.time),[0,200,400]);
  await rpc(input,request('sendTransaction'));assert.equal(calls.at(-1).time,400);
});
test('429 retries are bounded for read-only requests and honor Retry-After',async()=>{
  const c=clock();let count=0;
  const rpc=createRpcReadFetch(async()=>new Response('',{status:++count<3?429:200,headers:{'retry-after':'1'}}),c);
  assert.equal((await rpc(input,request('simulateTransaction'))).status,200);assert.equal(count,3);assert.equal(c.now(),2000);
});
test('persistent 429 and long cooldown are returned without unbounded retry',async()=>{
  for(const header of ['1','60']){const c=clock();let count=0;
    const rpc=createRpcReadFetch(async()=>{count++;return new Response('',{status:429,headers:{'retry-after':header}});},c);
    assert.equal((await rpc(input,request('getAccountInfo'))).status,429);assert.equal(count,header==='1'?3:1);
  }
});
test('sendTransaction, unknown methods, other errors and aborted requests never receive automatic retries',async()=>{
  for(const method of ['sendTransaction','requestAirdrop','unknown']){let count=0;const rpc=createRpcReadFetch(async()=>{count++;return new Response('',{status:429});},clock());await rpc(input,request(method));assert.equal(count,1);}
  let count=0;const rpc=createRpcReadFetch(async()=>{count++;return new Response('',{status:503});},clock());await rpc(input,request('getBalance'));assert.equal(count,1);
  const controller=new AbortController();controller.abort();await assert.rejects(rpc(input,{...request('getBalance'),signal:controller.signal}));assert.equal(count,1);
});
