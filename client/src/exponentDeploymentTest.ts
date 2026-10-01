import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
const loaded = await import('../../web/src/server/exponent/deployment.ts');
const exponentDeploymentReady = loaded.exponentDeploymentReady ?? (loaded as unknown as { default: typeof loaded }).default.exponentDeploymentReady;

const elf = readFileSync('../target/deploy/yield_vault.so');
const programData = new PublicKey('GYgDydSMpo3RbbPRgg4bA71czMM7PKQbLqWyDjWb2ukY');
const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const program = Buffer.alloc(36);
program.writeUInt32LE(2, 0);
programData.toBuffer().copy(program, 4);
const data = Buffer.concat([Buffer.alloc(45), elf]);
data.writeUInt32LE(3, 0);

function mock(programBytes: Buffer, code: Buffer): Connection {
  return { getMultipleAccountsInfo: async () => [
    { data: programBytes, executable: true, owner: loader },
    { data: code, executable: false, owner: loader },
  ] } as unknown as Connection;
}

async function main() {
  assert.equal(elf.length, 811_288, 'unexpected local ELF size');
  assert.equal(await exponentDeploymentReady(mock(program, data)), true);
  const changed = Buffer.from(data); changed[changed.length - 1] ^= 1;
  assert.equal(await exponentDeploymentReady(mock(program, changed)), false);
  assert.equal(await exponentDeploymentReady(mock(program, data.subarray(0, -1))), false);
  const wrongPointer = Buffer.from(program); wrongPointer[4] ^= 1;
  assert.equal(await exponentDeploymentReady(mock(wrongPointer, data)), false);
  assert.equal(await exponentDeploymentReady({ getMultipleAccountsInfo: async () => { throw Error('RPC unavailable'); } } as unknown as Connection), false);
  console.log('PASS: reviewed ELF deployment gate');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
