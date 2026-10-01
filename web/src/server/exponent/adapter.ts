import { Connection, PublicKey } from '@solana/web3.js';
import { Vault, MarketThree, LOCAL_ENV } from '@exponent-labs/exponent-sdk';
import { getSwapQuote, QuoteDirection } from '@exponent-labs/market-three-math';
import { WhirlpoolContext, buildWhirlpoolClient, swapQuoteByInputToken, ORCA_WHIRLPOOL_PROGRAM_ID, IGNORE_CACHE, UseFallbackTickArray } from '@orca-so/whirlpools-sdk';
import { Percentage } from '@orca-so/common-sdk';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import { createHash } from 'node:crypto';
import { EXPONENT, EXPONENT_MARKET, SAFE_PROGRAM, type ExponentAction, rawAmount, minimum, exitBasis, projectedProfitFee, safeAddress, positionAddress, decodePosition } from '../../lib/exponentV2';

export type QuoteRequest={market?:string;action:ExponentAction;amount:string;asset?:'USDC'|'ONYC';owner?:string;authority?:string;slippageBps?:number};
export const emptyWallet=(publicKey:PublicKey)=>({publicKey,signTransaction:async()=>{throw Error('unsigned only')},signAllTransactions:async()=>{throw Error('unsigned only')}});
const integer=(n:number)=>{if(!Number.isFinite(n)||n<=0||n>Number.MAX_SAFE_INTEGER)throw Error('unquotable output');return BigInt(Math.floor(n));};
export async function loadMarket(connection:Connection,withDex=true) {
  const core=await Vault.load(LOCAL_ENV,connection,new PublicKey(EXPONENT.coreVault));
  const market=await MarketThree.load(LOCAL_ENV,connection,new PublicKey(EXPONENT.market),core);
  if(!core.mintPt.equals(new PublicKey(EXPONENT.pt))||core.flavor.mintBase.toBase58()!==EXPONENT.onyc||market.flavor.mintBase.toBase58()!==EXPONENT.onyc)throw Error('unexpected market');
  if(market.flavor.flavor!=='generic')throw Error('unsupported SY flavor');
  const g=market.flavor.genericSyState;
  if(!g || !('scope' in g.account.interfaceType) || g.account.hook.enabled
    ||g.account.interfaceAccounts.length!==1||g.account.interfaceAccounts[0].toBase58()!==EXPONENT.scope)throw Error('unsupported ONyc oracle or hook');
  const scope=(g.account.interfaceType as {scope:{priceChain:number[];maximumAgeSeconds:BN}}).scope;
  if(scope.priceChain.join(',')!=='108,65535,65535,65535'||scope.maximumAgeSeconds.toString()!=='600')throw Error('ONyc Scope policy changed');
  const context=withDex?WhirlpoolContext.from(connection,emptyWallet(new PublicKey(EXPONENT.coreVault)) as never):null;
  const pool=context?await buildWhirlpoolClient(context).getPool(new PublicKey(EXPONENT.whirlpool),IGNORE_CACHE):null;
  if(pool) {const d=pool.getData();
    if(d.tokenMintA.toBase58()!==EXPONENT.onyc||d.tokenMintB.toBase58()!==EXPONENT.usdc||d.tickSpacing!==1)throw Error('unsupported ONyc pool');}
  const clock=await connection.getAccountInfo(new PublicKey('SysvarC1ock11111111111111111111111111111111'),'confirmed');
  if(!clock||clock.data.length!==40)throw Error('clock unavailable');
  const now=Number(clock.data.readBigInt64LE(32));
  // SDK 0.9.29 returns the SY cached index for Scope. Read the feed itself for a fresh quote.
  // Official Scope OraclePrices: discriminator + mappings pubkey + 512 DatedPrice[56].
  const feed=await connection.getAccountInfo(new PublicKey(EXPONENT.scope),'confirmed');
  if(!feed||feed.data.length!==28712||feed.owner.toBase58()!=='HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ'
    ||feed.data.subarray(0,8).toString('hex')!=='598076dd0648b492')throw Error('unsupported Scope feed');
  const offset=40+108*56,value=feed.data.readBigUInt64LE(offset),exp=feed.data.readBigUInt64LE(offset+8);
  const oracleSlot=feed.data.readBigUInt64LE(offset+16).toString(),oracleTimestamp=Number(feed.data.readBigUInt64LE(offset+24));
  if(value===BigInt(0)||exp>BigInt(38)||oracleTimestamp>now||now-oracleTimestamp>=600)throw Error('stale or invalid Scope price');
  const navDecimal=new Decimal(value.toString()).div(new Decimal(10).pow(exp.toString())).toString(),nav=Number(navDecimal);
  if(!Number.isFinite(nav)||nav<=0)throw Error('invalid NAV');
  return {connection,core,market,context,pool,nav,navDecimal,oracleSlot,oracleTimestamp,now,slot:clock.data.readBigUInt64LE(0).toString()};
}
export type Loaded=Awaited<ReturnType<typeof loadMarket>>;
export async function dex(state:Loaded,buy:boolean,amount:bigint,bps:number) {
  if(!state.pool||!state.context)throw Error('DEX not loaded for ONyc settlement');
  return swapQuoteByInputToken(state.pool,new PublicKey(buy?EXPONENT.usdc:EXPONENT.onyc),new BN(amount.toString()),Percentage.fromFraction(bps,10000),ORCA_WHIRLPOOL_PROGRAM_ID,state.context.fetcher,IGNORE_CACHE,UseFallbackTickArray.Never);
}
async function readPosition(connection:Connection,owner?:string) {
  if(!owner)return null;
  const safe=safeAddress(new PublicKey(owner)),address=positionAddress(safe),info=await connection.getAccountInfo(address,'confirmed');
  if(!info)return null;if(!info.owner.equals(SAFE_PROGRAM))throw Error('invalid position owner');
  const p=decodePosition(info.data,address);if(p.safe!==safe.toBase58())throw Error('foreign position');return p;
}
export async function marketInfo(connection:Connection) {
  const s=await loadMarket(connection);
  return {id:EXPONENT_MARKET,market:EXPONENT.market,coreVault:EXPONENT.coreVault,ptMint:EXPONENT.pt,baseMint:EXPONENT.onyc,
    decimals:{usdc:6,pt:9,onyc:9},maturity:new Date(EXPONENT.maturity*1000).toISOString(),chainTime:s.now,slot:s.slot,
    nav:{value:s.navDecimal,source:'on-chain Scope index 108',oracleTimestamp:s.oracleTimestamp,oracleSlot:s.oracleSlot,positionSnapshotScale:'1000000000000'},
    route:'USDC or ONyc → PT (Exponent CLMM); sale or maturity redemption → ONyc or USDC via Orca',
    leveraged:false,pilotFeeBps:0,futureDisplayProfitFeeBps:500,defaultMaxLossBps:500,maxSlippageBps:100,
    executionReady:false,reason:'Safe upgrade and owner-signed mainnet acceptance cycle require separate approval'};
}
export async function quote(connection:Connection,request:QuoteRequest) {
  if(request.market&&request.market!==EXPONENT_MARKET)throw Error('unsupported market');
  if(!['buy','sell','redeem'].includes(request.action))throw Error('unsupported action');
  const asset=request.asset??'USDC';if(asset!=='USDC'&&asset!=='ONYC')throw Error('unsupported asset');
  const amount=rawAmount(request.amount);
  // Upstream CLMM quote math uses doubles: bound raw input below 2^53. Settlement stays u64.
  if(amount>(request.action==='buy'?(asset==='USDC'?BigInt(10_000_000_000):BigInt(20_000_000_000_000)):BigInt(20_000_000_000_000)))throw Error('pilot quote size exceeds reviewed math range');
  if(request.owner)new PublicKey(request.owner);if(request.authority)new PublicKey(request.authority);
  const slippageBps=request.slippageBps??50;
  if(!Number.isInteger(slippageBps)||slippageBps<2||slippageBps>100)throw Error('slippageBps must be 2..100');
  const legBps=Math.floor(slippageBps/2),s=await loadMarket(connection,asset==='USDC'),p=await readPosition(connection,request.owner);
  if(request.action==='buy'&&s.now>=EXPONENT.maturity)throw Error('market matured');
  if(request.action==='sell'&&s.now>=EXPONENT.maturity)throw Error('use redemption after maturity');
  const math={financials:s.market.state.financials,configurationOptions:s.market.state.configurationOptions,ticks:s.market.state.ticks,currentSyExchangeRate:s.nav};
  const frozenRate=s.core.state.finalSyExchangeRate;
  const redemptionRate=request.action==='redeem'&&s.now>=EXPONENT.maturity&&frozenRate>0
    ?String(frozenRate):String(Math.max(s.nav,s.core.state.allTimeHighSyExchangeRate));
  let intermediate:bigint,expected:bigint,minIntermediate:bigint,minOutput:bigint;
  let swap:Awaited<ReturnType<typeof dex>>|null=null,basis:bigint|null=null;
  if(request.action==='buy') {
    if(asset==='USDC') {swap=await dex(s,true,amount,legBps);intermediate=BigInt(swap.estimatedAmountOut.toString());minIntermediate=minimum(intermediate,legBps);}
    else {intermediate=amount;minIntermediate=amount;}
    const calc=(base:bigint)=>integer(getSwapQuote(math,Number(base),QuoteDirection.SyToPt).amountOut);
    expected=calc(intermediate);minOutput=minimum(calc(minIntermediate),asset==='USDC'?legBps:slippageBps);
  } else {
    if(p)basis=exitBasis(BigInt(p.principalUsdc),BigInt(p.trackedPt),amount);
    // Before maturity this is only an indicative scenario at today's NAV.
    intermediate=request.action==='sell'?integer(getSwapQuote(math,Number(amount),QuoteDirection.PtToSy).amountOut)
      :BigInt(new Decimal(amount.toString()).div(redemptionRate).floor().toFixed(0));
    minIntermediate=minimum(intermediate,legBps);
    if(asset==='USDC') {swap=await dex(s,false,intermediate,legBps);expected=BigInt(swap.estimatedAmountOut.toString());
      const worst=await dex(s,false,minIntermediate,legBps);minOutput=minimum(BigInt(worst.estimatedAmountOut.toString()),legBps);}
    else {expected=intermediate;minOutput=minimum(intermediate,slippageBps);}
  }
  const quoteFloor=minimum(expected,slippageBps);if(minOutput<quoteFloor)minOutput=quoteFloor;
  const lossFloor=basis===null||asset==='ONYC'?null:minimum(basis,p?.maxLossBps??500),economicAllowed=lossFloor===null||expected>=lossFloor;
  if(lossFloor!==null&&minOutput<lossFloor&&economicAllowed)minOutput=lossFloor;
  const maturityOnyc=request.action==='buy'?BigInt(new Decimal(expected.toString()).div(s.navDecimal).floor().toFixed(0)):null;
  const maturityDex=maturityOnyc===null||asset==='ONYC'?null:await dex(s,false,maturityOnyc,slippageBps);
  const maturityUsdc=maturityDex===null?null:BigInt(maturityDex.estimatedAmountOut.toString());
  const inputBasis=asset==='USDC'?amount:BigInt(new Decimal(amount.toString()).mul(s.navDecimal).div(1000).ceil().toFixed(0));
  const projectedFee=maturityUsdc===null?null:projectedProfitFee(inputBasis,maturityUsdc);
  const secondsToMaturity=EXPONENT.maturity-s.now;
  const annualize=(proceeds:bigint)=>new Decimal(proceeds.toString()).div(inputBasis.toString())
    .pow(new Decimal(31_536_000).div(secondsToMaturity)).minus(1).toString();
  const result={market:EXPONENT_MARKET,action:request.action,owner:request.owner??null,authority:request.authority??request.owner??null,
    asset,input:{mint:request.action==='buy'?(asset==='USDC'?EXPONENT.usdc:EXPONENT.onyc):EXPONENT.pt,raw:amount.toString()},
    intermediate:{mint:EXPONENT.onyc,expectedRaw:intermediate.toString(),minRaw:minIntermediate.toString()},
    output:{mint:request.action==='buy'?EXPONENT.pt:(asset==='USDC'?EXPONENT.usdc:EXPONENT.onyc),expectedRaw:expected.toString(),minRaw:minOutput.toString()},
    slot:s.slot,chainTime:s.now,expiresAt:Math.min(s.now+90,s.oracleTimestamp+599),slippageBps,nav:s.navDecimal,navSource:'on-chain Scope 108',oracleTimestamp:s.oracleTimestamp,oracleSlot:s.oracleSlot,
    redemptionRate:request.action==='redeem'?redemptionRate:null,redemptionRateFrozen:request.action==='redeem'&&frozenRate>0,
    basisUsdc:basis?.toString()??null,inputBasisUsdc:request.action==='buy'?inputBasis.toString():null,
    maturityOnycAtCurrentNavRaw:maturityOnyc?.toString()??null,lossFloorUsdc:lossFloor?.toString()??null,economicAllowed,
    position:p,pilotFeeBps:0,pilotFeeUsdc:'0',previewOnly:request.action==='redeem'&&s.now<EXPONENT.maturity,executionReady:false,
    maturityPreview:maturityOnyc===null||maturityUsdc===null?null:{ptRaw:expected.toString(),onycRaw:maturityOnyc.toString(),usdcAtCurrentDexRaw:maturityUsdc.toString(),
      projectedFutureProfitFeeUsdc:projectedFee!.toString(),projectedNetUsdc:(maturityUsdc!-projectedFee!).toString(),
      grossApyBeforeDexFees:annualize(expected/BigInt(1000)),netApyAfterCurrentDexAndFutureProfitFee:annualize(maturityUsdc-projectedFee!),displayProfitFeeBps:500,
      assumption:'Current NAV and current DEX liquidity; maturity NAV, liquidity and fees are unknown'},
    route:{dex:asset==='USDC'?'Orca Whirlpool direct ONyc/USDC':null,pool:asset==='USDC'?EXPONENT.whirlpool:null,pt:request.action==='redeem'?'Exponent Core merge':'Exponent CLMM',
      routerFeeBps:0,networkFeeIncluded:false,rentIncluded:false}};
  return {public:{...result,quoteId:createHash('sha256').update(JSON.stringify(result)).digest('hex')},state:s,swap};
}
