/** Read-only discovery of the reviewed ONyc market. No wallet or sending API. */
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { Vault, MarketThree, LOCAL_ENV } from '@exponent-labs/exponent-sdk';
import { createRequire } from 'node:module';
const { quote }=createRequire(import.meta.url)('../../web/src/server/exponent/adapter.ts') as typeof import('../../web/src/server/exponent/adapter.js');
import { WhirlpoolContext, buildWhirlpoolClient, swapQuoteByInputToken, ORCA_WHIRLPOOL_PROGRAM_ID, IGNORE_CACHE, UseFallbackTickArray } from '@orca-so/whirlpools-sdk';
import { Percentage } from '@orca-so/common-sdk';
import BN from 'bn.js';
import { writeFileSync } from 'node:fs';

const connection = new Connection('https://api.mainnet-beta.solana.com', {commitment:'confirmed', fetch: async (url,opts) => {
  const res=await fetch(url,{...opts,signal:AbortSignal.timeout(20000)});
  if(!res.ok) console.error('RPC status',res.status);
  return res;
}});
const pt = new PublicKey('HH7FiYbEfDwQoK2ZJpkMz1T6wG6TqPsWcxWCtEVgigrZ');
const onyc = new PublicKey('5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5');
const usdc = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
console.log('Loading Core');
const core = await Vault.load(LOCAL_ENV, connection, new PublicKey('7f1PgxY3kGsPqLAKpwcduZkcBEhpjMz7U1iJ4pcCCzDy'));
console.log('Loaded Core');
const candidates = await connection.getProgramAccounts(new PublicKey('XPC1MM4dYACDfykNuXYZ5una2DsMDWL24CrYubCvarC'), {filters: [{memcmp: {offset:72, bytes:pt.toBase58()}}]});
console.log('CLMM markets', candidates.map(a=>a.pubkey.toBase58()));
const wallet = { publicKey: Keypair.generate().publicKey, signTransaction: async () => {throw Error('read only')}, signAllTransactions: async () => {throw Error('read only')} };
const ctx = WhirlpoolContext.from(connection, wallet as never);
const pool = await buildWhirlpoolClient(ctx).getPool(new PublicKey('7jhhyxPUKpu42hPGSYwgMXbR2dtVJHKhs8DW3sAAgAvX'));
console.log('pool', JSON.stringify(pool.getData(), (_,v)=>typeof v==='bigint'?v.toString():v));
const safe = PublicKey.findProgramAddressSync([Buffer.from('vault'),wallet.publicKey.toBuffer()],new PublicKey('yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih'))[0];
for (const candidate of candidates) {
  const m = await MarketThree.load(LOCAL_ENV,connection,candidate.pubkey,core);
  console.log('market', m.selfAddress.toBase58(), 'SYrate',m.currentSyExchangeRate,'state keys',Object.keys(m.state),'flavor keys',Object.keys(m.flavor));
  if(m.flavor.flavor!=='generic')throw Error('unexpected flavor');
  const summary: any = { market:m.selfAddress.toBase58(), syRate:m.currentSyExchangeRate, core:core.toJson(), state:{...m.state, vault:undefined, flavor:undefined}, generic:m.flavor.genericSyState, safe:safe.toBase58(), instructions:{} };
  for(const [action,bundle] of Object.entries({buy:await m.ixWrapperBuyPt({owner:safe,baseIn:1000000000n,minPtOut:1n}),sell:await m.ixWrapperSellPt({owner:safe,amount:1000000000n,minBaseOut:1n}),redeem:await core.ixMergeToBase({owner:safe,payer:wallet.publicKey,amountPy:1000000000n})})) {
    summary.instructions[action] = bundle.ixs.map(ix=>({program:ix.programId.toBase58(),data:ix.data.toString('hex'),keys:ix.keys.map(k=>({key:k.pubkey.toBase58(),signer:k.isSigner,writable:k.isWritable}))}));
    console.log(action, summary.instructions[action]);
  }
  for (const amount of [100,1000,10000]) {
    const buy=await quote(connection,{action:'buy',amount:String(amount*1e6)});
    const sell=await quote(connection,{action:'sell',amount:buy.public.output.expectedRaw});
    console.log('quotes',JSON.stringify({amount,buy:buy.public,sell:sell.public}));
  }
  writeFileSync(process.env.EXPONENT_INSPECT_FILE || 'exponent-inspect.json',JSON.stringify(summary,(_,v)=>typeof v==='bigint'?v.toString():v,2));
}
