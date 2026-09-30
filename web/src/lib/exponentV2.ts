import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { createHash } from 'node:crypto';
import manifest from './exponent-onyc-10jan27.json';

export const EXPONENT_MARKET = 'onyc-10jan27';
export const SAFE_PROGRAM = new PublicKey('yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih');
export const EXPONENT = {
  ...manifest,
  usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  onyc: '5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5',
  pt: 'HH7FiYbEfDwQoK2ZJpkMz1T6wG6TqPsWcxWCtEVgigrZ',
  sy: 'G1qbuP11CdquJCzuDjruWqatQAHroajmxhLfeQVgHosF',
  yt: 'GFpXWuDCm7QMjkYbMveNZoLzybqJaginDDvuX3bJqgLF',
  syProgram: 'XP1BRLn8eCYSygrd8er5P4GKdzqKbC3DLoSsS5UYVZy',
  coreProgram: 'ExponentnaRg3CQbW6dqQNZKXp7gtZ9DGMp1cwC4HAS7',
  clmmProgram: 'XPC1MM4dYACDfykNuXYZ5una2DsMDWL24CrYubCvarC',
  orcaProgram: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
} as const;
export type ExponentAction = 'buy' | 'sell' | 'redeem';
export const U64_MAX = (BigInt(1)<<BigInt(64))-BigInt(1);
export function rawAmount(value: unknown): bigint {
  if(typeof value!=='string'|| !/^[1-9]\d{0,19}$/.test(value)) throw Error('amount must be a positive raw integer string');
  const amount=BigInt(value);if(amount>U64_MAX)throw Error('amount exceeds u64');return amount;
}
export function minimum(amount: bigint, bps: number) {
  if(!Number.isInteger(bps)||bps<0||bps>500)throw Error('invalid bps');
  return (amount*BigInt(10000-bps)+BigInt(9999))/BigInt(10000);
}
export function exitBasis(principal: bigint, tracked: bigint, amount: bigint) {
  if(tracked<=BigInt(0)||amount<=BigInt(0)||amount>tracked)throw Error('insufficient tracked PT');
  return amount===tracked ? principal : principal*amount/tracked;
}
/** Future display policy only. The pilot charges zero; never subtract five percentage points. */
export function projectedProfitFee(principal: bigint, received: bigint, feeBps=500) {
  if(!Number.isInteger(feeBps)||feeBps<0||feeBps>2000)throw Error('invalid fee');
  return (received>principal?received-principal:BigInt(0))*BigInt(feeBps)/BigInt(10000);
}
export function safeAddress(owner: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('vault'),owner.toBuffer()],SAFE_PROGRAM)[0];
}
export function positionAddress(safe: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('exponent_position'),safe.toBuffer(),new PublicKey(EXPONENT.coreVault).toBuffer()],SAFE_PROGRAM)[0];
}
export function tokenAddress(owner: PublicKey, mint: string) {
  return getAssociatedTokenAddressSync(new PublicKey(mint),owner,true,TOKEN_PROGRAM_ID);
}
export function instructionTag(name: string) {return createHash('sha256').update('global:'+name).digest().subarray(0,8);}
function roleKey(role: number, key: string, safe: PublicKey) {
  return role===1 ? safe : role>=2&&role<=5 ? tokenAddress(safe,[EXPONENT.onyc,EXPONENT.pt,EXPONENT.sy,EXPONENT.yt][role-2]) : new PublicKey(key);
}
export function exponentAccounts(action: ExponentAction, safe: PublicKey) {
  const template=EXPONENT.actions[action];
  return [{pubkey:new PublicKey(template.program),isSigner:false,isWritable:false},
    ...template.accounts.map(a=>({pubkey:roleKey(a.role,a.key,safe),isSigner:false,isWritable:a.writable}))];
}
/** The SDK is an untrusted account source. Compare keys, signer and writable flags to the review. */
export function assertExponentInstruction(action: ExponentAction,safe:PublicKey,ix:TransactionInstruction) {
  const template=EXPONENT.actions[action];
  if(ix.programId.toBase58()!==template.program||ix.keys.length!==template.accounts.length
    ||ix.data[0]!==parseInt(template.discriminator,16)||ix.data.at(-1)!==10)throw Error('upstream Exponent layout changed');
  template.accounts.forEach((a,i)=>{
    const k=ix.keys[i];if(!k.pubkey.equals(roleKey(a.role,a.key,safe))||k.isSigner!==a.signer||k.isWritable!==a.writable)
      throw Error('upstream Exponent accounts changed');
  });
  if(ix.data.length!==(action==='redeem'?10:19))throw Error('upstream Exponent encoding changed');
}
export type ExponentPositionState = {
  address:string; safe:string; market:string; ptMint:string; baseMint:string; maturity:number;
  enabled:boolean; maxLossBps:number; maxSlippageBps:number; feeBps:number;
  trackedPt:string; principalUsdc:string; totalSpentUsdc:string; totalReceivedUsdc:string;
  realizedBasisUsdc:string; feesPaidUsdc:string; recoveredBasisUsdc:string;
  entryNavWords:string[]; entryCoreRateWords:string[]; entrySlot:string; entryTimestamp:string;
};
export function decodePosition(data:Buffer,address:PublicKey):ExponentPositionState {
  if(data.length!==288||!data.subarray(0,8).equals(createHash('sha256').update('account:ExponentPosition').digest().subarray(0,8)))throw Error('invalid position layout');
  let o=8;
  const key=()=>{const v=new PublicKey(data.subarray(o,o+32)).toBase58();o+=32;return v;};
  const safe=key(),market=key(),ptMint=key(),baseMint=key();
  const maturity=Number(data.readBigInt64LE(o));o+=8;
  o++; const enabled=data[o++]!==0;
  const u16=()=>{const v=data.readUInt16LE(o);o+=2;return v;};
  const maxLossBps=u16(),maxSlippageBps=u16(),feeBps=u16();
  const u64=()=>{const v=data.readBigUInt64LE(o).toString();o+=8;return v;};
  const trackedPt=u64(),principalUsdc=u64(),totalSpentUsdc=u64(),totalReceivedUsdc=u64(),realizedBasisUsdc=u64(),feesPaidUsdc=u64(),recoveredBasisUsdc=u64();
  const entryNavWords=Array.from({length:4},u64),entryCoreRateWords=Array.from({length:4},u64),entrySlot=u64();
  const entryTimestamp=data.readBigInt64LE(o).toString();
  if(market!==EXPONENT.coreVault||ptMint!==EXPONENT.pt||baseMint!==EXPONENT.onyc||maturity!==EXPONENT.maturity)throw Error('unsupported position');
  return {address:address.toBase58(),safe,market,ptMint,baseMint,maturity,enabled,maxLossBps,maxSlippageBps,feeBps,trackedPt,principalUsdc,totalSpentUsdc,totalReceivedUsdc,realizedBasisUsdc,feesPaidUsdc,recoveredBasisUsdc,entryNavWords,entryCoreRateWords,entrySlot,entryTimestamp};
}
