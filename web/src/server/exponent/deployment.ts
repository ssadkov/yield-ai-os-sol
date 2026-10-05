import { createHash } from 'node:crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import { SAFE_PROGRAM } from '../../lib/exponentV2';

// Exact reviewed ELF. Rebuilds require a new review and hash before execution is enabled.
const PROGRAM_DATA = new PublicKey('GYgDydSMpo3RbbPRgg4bA71czMM7PKQbLqWyDjWb2ukY');
const ELF_BYTES = 686_960;
const ELF_SHA256 = '9543eb14e69694d25d6a4d1bba2a5bcc7f00f1d34a095112d0b898764805269f';
const DYNAMIC_ELF_BYTES=690944;
const DYNAMIC_ELF_SHA256='48da204eea62b79db16474045a2ede6e139c54e4d1023f99b09dfc3adfe7565d';

export async function exponentDeploymentVersion(connection: Connection): Promise<'fixed_ticks'|'dynamic_ticks'|null> {
  try {
    const [program, data] = await connection.getMultipleAccountsInfo([SAFE_PROGRAM, PROGRAM_DATA], 'confirmed');
    if (!program?.executable || !data || !data.owner.equals(program.owner)) return null;
    if (program.data.readUInt32LE(0) !== 2 || !new PublicKey(program.data.subarray(4, 36)).equals(PROGRAM_DATA)) return null;
    if (data.data.length < 45 + ELF_BYTES || data.data.readUInt32LE(0) !== 3) return null;
    if(data.data.length>=45+DYNAMIC_ELF_BYTES && createHash('sha256').update(data.data.subarray(45,45+DYNAMIC_ELF_BYTES)).digest('hex')===DYNAMIC_ELF_SHA256)return 'dynamic_ticks';
    const hash=createHash('sha256').update(data.data.subarray(45,45+ELF_BYTES)).digest('hex');
    return hash===ELF_SHA256?'fixed_ticks':null;
  } catch { return null; }
}

export async function exponentDeploymentReady(connection:Connection) { return (await exponentDeploymentVersion(connection))!==null; }
