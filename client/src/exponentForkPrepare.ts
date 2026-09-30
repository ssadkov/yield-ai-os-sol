/** Read-only Mainnet snapshot. ELF/account files are fixtures for local bankrun only. */
import { Connection, PublicKey } from '@solana/web3.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import manifest from '../../web/src/lib/exponent-onyc-10jan27.json' with {type:'json'};
import { ParsableWhirlpool } from '@orca-so/whirlpools-sdk';

const out=process.env.EXPONENT_FORK_DIR;if(!out)throw Error('EXPONENT_FORK_DIR required');mkdirSync(out,{recursive:true});
const connection=new Connection('https://api.mainnet-beta.solana.com',{commitment:'confirmed',fetch:(url,options)=>fetch(url,{...options,signal:AbortSignal.timeout(30_000)})});
const programs=[['exponent_core','ExponentnaRg3CQbW6dqQNZKXp7gtZ9DGMp1cwC4HAS7'],['exponent_clmm','XPC1MM4dYACDfykNuXYZ5una2DsMDWL24CrYubCvarC'],['generic_sy','XP1BRLn8eCYSygrd8er5P4GKdzqKbC3DLoSsS5UYVZy'],['whirlpool','whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc']];
const keys=new Set<string>([...manifest.lookupTables,manifest.coreVault,manifest.syMeta,manifest.scope,manifest.whirlpool,
  '4SNzvPoPnnzR6sz5GdEnUpSFoZQUSnpX6KpXRKzDDfLh','EFK2eCu8FoEJerhf9P877oT3wWuq5ciAGWHR21jJaebY',
  '4AnnpKm2SYDWHcWyuPp8q73Ge72wRgxXxvrwE8Z722fS','SysvarC1ock11111111111111111111111111111111',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v']);
for(const a of Object.values(manifest.actions))for(const k of a.accounts)if(k.role===0)keys.add(k.key);
const poolAddress=new PublicKey(manifest.whirlpool),poolInfo=await connection.getAccountInfo(poolAddress);
const pool=poolInfo&&ParsableWhirlpool.parse(poolAddress,poolInfo);if(!pool)throw Error('missing Whirlpool');
for(const reward of pool.rewardInfos)if(!reward.mint.equals(PublicKey.default)){keys.add(reward.mint.toBase58());keys.add(reward.vault.toBase58());}
for(const [name,id] of programs) {
  const info=await connection.getAccountInfo(new PublicKey(id));if(!info||info.data.length!==36||info.data.readUInt32LE()!==2)throw Error('unexpected program loader');
  const pd=new PublicKey(info.data.subarray(4,36)),data=await connection.getAccountInfo(pd);if(!data||data.data.readUInt32LE()!==3)throw Error('invalid ProgramData');
  const elf=data.data.subarray(45);writeFileSync(out+'/'+name+'.so',elf);
  console.log(JSON.stringify({name,id,programData:pd.toBase58(),bytes:elf.length,sha256:createHash('sha256').update(elf).digest('hex')}));
}
const all=[...keys].filter(k=>k!=='11111111111111111111111111111111'&&k!=='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'&&!programs.some(p=>p[1]===k));
const accounts:{address:string;lamports:number;owner:string;executable:boolean;data:string}[]=[];
const optional=['2xBrZFinVdw1Z88kBXcnTEw8TYr8WUUSJaNcrKB5pode','2qFqt7c5teKuuTMT7FCG24DzvsUwicuYovGpKAoB2XnK',
  '8gPKRueXeCRggCpndh25KAcwwBbfSx1QhgRY7qEfB2bT']; // Core vault authority, signer PDA without data
const oracle=PublicKey.findProgramAddressSync([Buffer.from('oracle'),new PublicKey(manifest.whirlpool).toBuffer()],new PublicKey(programs[3][1]))[0].toBase58();
all.push(oracle);optional.push(oracle);
for(let i=0;i<all.length;i+=40) {
 const batch=all.slice(i,i+40),data=await connection.getMultipleAccountsInfo(batch.map(k=>new PublicKey(k)));
 data.forEach((info,index)=>{if(!info){if(optional.includes(batch[index]))return;throw Error('missing upstream account '+batch[index]);}accounts.push({address:batch[index],lamports:info.lamports,owner:info.owner.toBase58(),executable:info.executable,data:info.data.toString('base64')});});
}
const file={fetchedAt:new Date().toISOString(),slot:await connection.getSlot(),programs:programs.map(([name,id])=>({name,programId:id})),accounts};
writeFileSync(out+'/snapshot.json',JSON.stringify(file));console.log('Saved',accounts.length,'public accounts at slot',file.slot);
