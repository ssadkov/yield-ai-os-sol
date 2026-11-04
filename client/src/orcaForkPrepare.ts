/** Read-only mainnet snapshot for the Orca fork test (client/src/v2OrcaFork.ts). Sends nothing. */
import { Connection, PublicKey } from '@solana/web3.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const out = process.env.ORCA_FORK_DIR;
if (!out) throw Error('ORCA_FORK_DIR required');
mkdirSync(out, { recursive: true });
const connection = new Connection(process.env.ORCA_READ_RPC || 'https://api.mainnet-beta.solana.com', {
  commitment: 'confirmed', fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(30_000) }),
});
const ORCA = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
// Upgradeable programs whose live ELF is used in the fork. Token-2022 is taken from mainnet so the
// position-NFT extensions behave exactly as in production.
const programs: [string, string][] = [['whirlpool', ORCA.toBase58()], ['token_2022', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']];
// Must match programs/yield-vault/src/orca.rs.
const pools = ['HxA6SKW5qA4o12fjVgTpXdq2YnZ5Zv1s7SB4FFomsyLM', '4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72'];
const fixed = [
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij',
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', 'Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX',
  '7oqYpv5YbjJ2PEsNeVVB5ZEZ8ZE6ufkj8hAvAiaiftbe', '9gNX5vguzarZZPjTnE1hWze3s6UsZ7dsU3UnAmKPnMHG',
  '4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo', // BTC/USD (prices cbBTC and WBTC)
  '2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ', 'SysvarC1ock11111111111111111111111111111111',
];
const keys = new Set<string>([...fixed, ...pools]);
const optional = new Set<string>();
const poolMeta: Record<string, { tickSpacing: number; tickCurrent: number; tickArrays: Record<string, string> }> = {};
for (const address of pools) {
  const info = await connection.getAccountInfo(new PublicKey(address));
  if (!info || !info.owner.equals(ORCA)) throw Error('missing pool ' + address);
  const d = info.data, spacing = d.readUInt16LE(41), tick = d.readInt32LE(81), span = 88 * spacing;
  keys.add(new PublicKey(d.subarray(133, 165)).toBase58());
  keys.add(new PublicKey(d.subarray(213, 245)).toBase58());
  const oracle = PublicKey.findProgramAddressSync([Buffer.from('oracle'), new PublicKey(address).toBuffer()], ORCA)[0].toBase58();
  keys.add(oracle); optional.add(oracle);
  const start = Math.floor(tick / span) * span, tickArrays: Record<string, string> = {};
  for (let i = -4; i <= 4; i++) {
    const s = start + i * span;
    const pda = PublicKey.findProgramAddressSync([Buffer.from('tick_array'), new PublicKey(address).toBuffer(), Buffer.from(String(s))], ORCA)[0].toBase58();
    tickArrays[String(s)] = pda; keys.add(pda); optional.add(pda);
  }
  poolMeta[address] = { tickSpacing: spacing, tickCurrent: tick, tickArrays };
}
const programFiles = [];
for (const [name, id] of programs) {
  const info = await connection.getAccountInfo(new PublicKey(id));
  if (!info || info.data.length !== 36 || info.data.readUInt32LE() !== 2) throw Error('unexpected program loader for ' + id);
  const pd = new PublicKey(info.data.subarray(4, 36)), data = await connection.getAccountInfo(pd);
  if (!data || data.data.readUInt32LE() !== 3) throw Error('invalid ProgramData for ' + id);
  const elf = data.data.subarray(45);
  writeFileSync(out + '/' + name + '.so', elf);
  const sha256 = createHash('sha256').update(elf).digest('hex');
  programFiles.push({ name, programId: id, programData: pd.toBase58(), bytes: elf.length, sha256 });
  console.log(JSON.stringify(programFiles.at(-1)));
}
const accounts: { address: string; lamports: number; owner: string; executable: boolean; data: string }[] = [];
const all = [...keys];
for (let i = 0; i < all.length; i += 50) {
  const batch = all.slice(i, i + 50), infos = await connection.getMultipleAccountsInfo(batch.map((k) => new PublicKey(k)));
  infos.forEach((info, index) => {
    if (!info) { if (optional.has(batch[index])) return; throw Error('missing account ' + batch[index]); }
    accounts.push({ address: batch[index], lamports: info.lamports, owner: info.owner.toBase58(), executable: info.executable, data: info.data.toString('base64') });
  });
}
const slot = await connection.getSlot();
writeFileSync(out + '/snapshot.json', JSON.stringify({ fetchedAt: new Date().toISOString(), slot, programs: programFiles, pools: poolMeta, accounts }));
console.log('Saved', accounts.length, 'accounts at slot', slot);
for (const [p, m] of Object.entries(poolMeta)) {
  const present = Object.entries(m.tickArrays).filter(([, k]) => accounts.some((a) => a.address === k)).map(([s]) => s);
  console.log(p, 'tick', m.tickCurrent, 'spacing', m.tickSpacing, 'initialized tick arrays', present.join(','));
}
