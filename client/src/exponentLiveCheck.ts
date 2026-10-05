/** Read-only preflight for the pinned ONyc market. Never signs or sends. */
import { Connection } from '@solana/web3.js';
import { createRequire } from 'node:module';
const { loadMarket, quote }=createRequire(import.meta.url)('../../web/src/server/exponent/adapter.ts') as typeof import('../../web/src/server/exponent/adapter.js');

const url=process.env.V2_MAINNET_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection=new Connection(url,'confirmed');
if(await connection.getGenesisHash()!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')throw Error('expected Solana Mainnet');
const state=await loadMarket(connection);
const usdc=await quote(connection,{action:'buy',amount:'1000000000'});
const onyc=await quote(connection,{action:'buy',amount:'100000000000',asset:'ONYC'});
const usdcExit=await quote(connection,{action:'sell',amount:usdc.public.output.expectedRaw});
const onycExit=await quote(connection,{action:'sell',amount:onyc.public.output.expectedRaw,asset:'ONYC'});
console.log(JSON.stringify({slot:state.slot,nav:state.navDecimal,oracleTimestamp:state.oracleTimestamp,
  usdcRoundTrip:{input:usdc.public.input.raw,expectedPt:usdc.public.output.expectedRaw,expectedExit:usdcExit.public.output.expectedRaw},
  onycRoundTrip:{input:onyc.public.input.raw,expectedPt:onyc.public.output.expectedRaw,expectedExit:onycExit.public.output.expectedRaw}},null,2));
