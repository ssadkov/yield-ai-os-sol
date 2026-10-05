import { Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { PDAUtil, ORCA_WHIRLPOOL_PROGRAM_ID } from '@orca-so/whirlpools-sdk';
import { EXPONENT, SAFE_PROGRAM, type ExponentAction, rawAmount, safeAddress, positionAddress, tokenAddress, instructionTag, exponentAccounts, assertExponentInstruction } from '../../lib/exponentV2';
import { quote, type QuoteRequest, type Loaded, dex, supportsDynamicTicksFromQuote } from './adapter';
import Decimal from 'decimal.js';
import { exponentDeploymentReady } from './deployment';
import { checkedOrcaTickArrays } from '../../lib/exponentOrca';

export const policyAddress=(seed:string,safe?:PublicKey)=>PublicKey.findProgramAddressSync([Buffer.from(seed),...(safe?[safe.toBuffer()]:[])],SAFE_PROGRAM)[0];
const meta=(pubkey:PublicKey,isWritable=false,isSigner=false)=>({pubkey,isWritable,isSigner});
async function orcaAccounts(s:Loaded,safe:PublicKey,swap:Awaited<ReturnType<typeof dex>>) {
  if(!s.pool)throw Error('Orca pool unavailable');
  const d=s.pool.getData();
  const arrays=[swap.tickArray0,swap.tickArray1,swap.tickArray2];
  await checkedOrcaTickArrays(s.connection,arrays,supportsDynamicTicksFromQuote(s));
  return [meta(new PublicKey(EXPONENT.orcaProgram)),meta(TOKEN_PROGRAM_ID),meta(safe),meta(new PublicKey(EXPONENT.whirlpool),true),
    ...[tokenAddress(safe,EXPONENT.onyc),d.tokenVaultA,tokenAddress(safe,EXPONENT.usdc),d.tokenVaultB,...arrays,
      PDAUtil.getOracle(ORCA_WHIRLPOOL_PROGRAM_ID,new PublicKey(EXPONENT.whirlpool)).publicKey].map(k=>meta(k,true))];
}
export function positionSetup(owner:PublicKey,lossBps=500,slippageBps=50) {
  if(!Number.isInteger(lossBps)||lossBps<0||lossBps>500||!Number.isInteger(slippageBps)||slippageBps<2||slippageBps>100)throw Error('invalid policy');
  const safe=safeAddress(owner),data=Buffer.alloc(4);data.writeUInt16LE(lossBps,0);data.writeUInt16LE(slippageBps,2);
  return new TransactionInstruction({programId:SAFE_PROGRAM,keys:[meta(owner,true,true),meta(safe),meta(positionAddress(safe),true),meta(SystemProgram.programId)],
    data:Buffer.concat([instructionTag('init_exponent_position'),data])});
}
async function treasuryAddress(connection:Connection) {
  const info=await connection.getAccountInfo(policyAddress('config'),'confirmed');
  if(!info||!info.owner.equals(SAFE_PROGRAM)||info.data.length<74)throw Error('Safe config unavailable');
  return new PublicKey(info.data.subarray(40,72));
}
async function serialize(connection:Connection,payer:PublicKey,ixs:TransactionInstruction[],withTables:boolean) {
  const tables=withTables?await Promise.all(EXPONENT.lookupTables.map(async a=>{
    const t=(await connection.getAddressLookupTable(new PublicKey(a))).value;
    if(!t||t.state.deactivationSlot!==(BigInt(1)<<BigInt(64))-BigInt(1))throw Error('market lookup table unavailable');return t;})):[];
  const {blockhash,lastValidBlockHeight}=await connection.getLatestBlockhash('confirmed');
  const tx=new VersionedTransaction(new TransactionMessage({payerKey:payer,recentBlockhash:blockhash,
    instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:10_000}),...ixs]}).compileToV0Message(tables));
  const bytes=tx.serialize();if(bytes.length>1232)throw Error('atomic route exceeds Solana transaction size');
  const sim=await connection.simulateTransaction(tx,{sigVerify:false,replaceRecentBlockhash:true,commitment:'confirmed'});
  const deployed=await exponentDeploymentReady(connection);
  const executionReady=sim.value.err===null&&deployed;
  return {unsignedTransaction:Buffer.from(bytes).toString('base64'),blockhash,lastValidBlockHeight,serializedBytes:bytes.length,requiredSigners:[payer.toBase58()],
    simulation:{error:sim.value.err,unitsConsumed:sim.value.unitsConsumed??null,logs:sim.value.logs??[]},
    networkFeeLamports:(await connection.getFeeForMessage(tx.message,'confirmed')).value,executionReady,
    deploymentStatus:!deployed?'Reviewed Safe ELF not deployed on Mainnet':sim.value.err===null?'Reviewed Safe ELF verified on Mainnet':'Transaction simulation failed; Safe ELF verified on Mainnet'};
}
/** Preparation is separate; neither SDK nor this API ever signs or sends a transaction. */
export async function unsignedSetup(connection:Connection,ownerString:string,lossBps=500,slippageBps=50) {
  const owner=new PublicKey(ownerString),safe=safeAddress(owner),treasury=await treasuryAddress(connection);
  const ixs=[...[EXPONENT.usdc,EXPONENT.onyc,EXPONENT.pt,EXPONENT.sy,EXPONENT.yt].map(m=>
    createAssociatedTokenAccountIdempotentInstruction(owner,tokenAddress(safe,m),safe,new PublicKey(m))),
    createAssociatedTokenAccountIdempotentInstruction(owner,tokenAddress(owner,EXPONENT.usdc),owner,new PublicKey(EXPONENT.usdc)),
    createAssociatedTokenAccountIdempotentInstruction(owner,tokenAddress(owner,EXPONENT.onyc),owner,new PublicKey(EXPONENT.onyc)),
    createAssociatedTokenAccountIdempotentInstruction(owner,tokenAddress(treasury,EXPONENT.usdc),treasury,new PublicKey(EXPONENT.usdc))];
  if(!await connection.getAccountInfo(positionAddress(safe),'confirmed'))ixs.push(positionSetup(owner,lossBps,slippageBps));
  return {action:'setup',safe:safe.toBase58(),position:positionAddress(safe).toBase58(),...await serialize(connection,owner,ixs,false)};
}
export async function unsignedOnycTransfer(connection:Connection,ownerString:string,action:'deposit_onyc'|'withdraw_onyc',amountString:string) {
  const owner=new PublicKey(ownerString),safe=safeAddress(owner),amount=rawAmount(amountString);
  const safeInfo=await connection.getAccountInfo(safe,'confirmed');
  if(!safeInfo||!safeInfo.owner.equals(SAFE_PROGRAM)||!new PublicKey(safeInfo.data.subarray(9,41)).equals(owner))throw Error('invalid Safe owner');
  const ownerToken=tokenAddress(owner,EXPONENT.onyc),safeToken=tokenAddress(safe,EXPONENT.onyc);
  const accounts=await connection.getMultipleAccountsInfo([ownerToken,safeToken],'confirmed');
  if(accounts.some(a=>a===null))throw Error('ONyc accounts missing; run setup');
  const data=Buffer.alloc(8);data.writeBigUInt64LE(amount);
  const ix=new TransactionInstruction({programId:SAFE_PROGRAM,keys:[meta(owner,false,true),meta(safe),meta(ownerToken,true),meta(safeToken,true),meta(TOKEN_PROGRAM_ID)],
    data:Buffer.concat([instructionTag(action),data])});
  return {action,owner:ownerString,safe:safe.toBase58(),amountRaw:amountString,...await serialize(connection,owner,[ix],false)};
}
export async function unsignedTransaction(connection:Connection,request:QuoteRequest & {minimumOutput?:string;quotedAt?:number}) {
  if(!request.owner)throw Error('owner required');
  const owner=new PublicKey(request.owner),authority=new PublicKey(request.authority??request.owner),safe=safeAddress(owner);
  const q=await quote(connection,request),p=q.public.position;
  if(q.public.asset==='ONYC'&&!authority.equals(owner))throw Error('ONyc settlement requires owner signature');
  if(q.public.previewOnly)throw Error('redemption is a forecast until maturity');
  if(!p)throw Error('owner must initialize the Exponent position with action=setup');
  if(!q.public.economicAllowed&&!authority.equals(owner))throw Error('exit exceeds executor loss policy');
  if(request.quotedAt!==undefined&&(!Number.isSafeInteger(request.quotedAt)||request.quotedAt>q.state.now||q.state.now-request.quotedAt>90))throw Error('stale quote');
  if(request.minimumOutput!==undefined&&rawAmount(request.minimumOutput)>BigInt(q.public.output.expectedRaw))throw Error('fresh quote is worse than requested minimum');
  const minOut=request.minimumOutput===undefined?BigInt(q.public.output.minRaw)
    :BigInt(request.minimumOutput)>BigInt(q.public.output.minRaw)?BigInt(request.minimumOutput):BigInt(q.public.output.minRaw);
  const treasury=await treasuryAddress(connection);
  const nominalOnyc=BigInt(new Decimal(q.public.intermediate.expectedRaw).mul(q.state.navDecimal).ceil().toFixed(0));
  const bundle=request.action==='buy'?await q.state.market.ixWrapperBuyPt({owner:safe,baseIn:nominalOnyc,minPtOut:minOut})
    :request.action==='sell'?await q.state.market.ixWrapperSellPt({owner:safe,amount:rawAmount(request.amount),minBaseOut:BigInt(q.public.intermediate.minRaw)})
    :await q.state.core.ixMergeToBase({owner:safe,payer:authority,amountPy:rawAmount(request.amount)});
  if(bundle.ixs.length!==1)throw Error('unsupported pre/post instructions');
  assertExponentInstruction(request.action,safe,bundle.ixs[0]);
  const safeInfo=await connection.getAccountInfo(safe,'confirmed');
  if(!safeInfo||!safeInfo.owner.equals(SAFE_PROGRAM)||safeInfo.data.length<73
    ||!new PublicKey(safeInfo.data.subarray(9,41)).equals(owner))throw Error('invalid Safe owner');
  const fixed=[meta(authority,true,true),meta(safe,true),meta(policyAddress('executor_registry')),meta(policyAddress('executor_limits',safe),true),
    meta(positionAddress(safe),true),meta(policyAddress('config')),
    ...[EXPONENT.usdc,EXPONENT.onyc,EXPONENT.pt,EXPONENT.sy,EXPONENT.yt].map(m=>meta(tokenAddress(safe,m),true)),
    meta(tokenAddress(owner,EXPONENT.usdc),true),meta(tokenAddress(treasury,EXPONENT.usdc),true),
    meta(new PublicKey(EXPONENT.coreVault),request.action==='redeem'),meta(new PublicKey(EXPONENT.syMeta),true),meta(TOKEN_PROGRAM_ID)];
  const missing=await connection.getMultipleAccountsInfo([...fixed.slice(6,13).map(a=>a.pubkey),...(q.public.asset==='ONYC'&&request.action!=='buy'?[tokenAddress(owner,EXPONENT.onyc)]:[])],'confirmed');
  if(missing.some(a=>a===null))throw Error('missing token accounts; run action=setup');
  const data=Buffer.alloc(40);data.writeBigUInt64LE(rawAmount(request.amount),0);data.writeBigUInt64LE(BigInt(q.public.intermediate.minRaw),8);
  data.writeBigUInt64LE(minOut,16);data.writeBigUInt64LE(BigInt(q.public.output.expectedRaw),24);data.writeBigInt64LE(BigInt(q.public.expiresAt),32);
  const exp=exponentAccounts(request.action,safe),orca=q.swap?await orcaAccounts(q.state,safe,q.swap):[];
  const nativeRecipient=q.public.asset==='ONYC'&&request.action!=='buy'?[meta(tokenAddress(owner,EXPONENT.onyc),true)]:[];
  const actionName=q.public.asset==='USDC'?'exponent_'+request.action+'_pt':request.action==='buy'?'exponent_buy_pt_with_onyc':
    'exponent_'+request.action+'_pt_for_onyc';
  const action=new TransactionInstruction({programId:SAFE_PROGRAM,keys:[...fixed,...nativeRecipient,...(request.action==='buy'?[...orca,...exp]:[...exp,...orca])],
    data:Buffer.concat([instructionTag(actionName),data])});
  return {quote:q.public,minimumOutputRaw:minOut.toString(),safe:safe.toBase58(),pilotPerformanceFeeUsdc:'0',...await serialize(connection,authority,[action],true)};
}
