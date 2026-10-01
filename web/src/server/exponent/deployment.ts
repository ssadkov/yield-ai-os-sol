import { createHash } from 'node:crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import { SAFE_PROGRAM } from '../../lib/exponentV2';

// Exact reviewed ELF. Rebuilds require a new review and hash before execution is enabled.
const PROGRAM_DATA = new PublicKey('GYgDydSMpo3RbbPRgg4bA71czMM7PKQbLqWyDjWb2ukY');
const ELF_BYTES = 811_288;
const ELF_SHA256 = '49c394d8bfc22315ae1f12320e6f390e56d433da39c2bfde4246026ef90480d3';

export async function exponentDeploymentReady(connection: Connection): Promise<boolean> {
  try {
    const [program, data] = await connection.getMultipleAccountsInfo([SAFE_PROGRAM, PROGRAM_DATA], 'confirmed');
    if (!program?.executable || !data || !data.owner.equals(program.owner)) return false;
    if (program.data.readUInt32LE(0) !== 2 || !new PublicKey(program.data.subarray(4, 36)).equals(PROGRAM_DATA)) return false;
    if (data.data.length < 45 + ELF_BYTES || data.data.readUInt32LE(0) !== 3) return false;
    return createHash('sha256').update(data.data.subarray(45, 45 + ELF_BYTES)).digest('hex') === ELF_SHA256;
  } catch { return false; }
}
