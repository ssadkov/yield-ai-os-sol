import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { SAFE_PROGRAM, instructionTag, safeAddress, type ExponentAction } from './exponentV2.ts';

/** Temporarily enable a disabled owner-selected route, then restore the executor policy atomically. */
export function exponentOwnerAllocation(owner: PublicKey, authority: PublicKey, action: ExponentAction, original: readonly number[]) {
  if (original.length !== 8 || original.some(bps => !Number.isInteger(bps) || bps < 0 || bps > 10_000)
      || original.reduce((sum, bps) => sum + bps, 0) > 10_000) throw Error('Invalid Safe allocation');
  const allocationBpsAfter = [...original];
  if (action !== 'buy' || !authority.equals(owner) || original[1] > 0)
    return { before: [] as TransactionInstruction[], after: [] as TransactionInstruction[], allocationBpsAfter };
  const instruction = (bps: readonly number[]) => {
    const data = Buffer.alloc(16);
    bps.forEach((value, index) => data.writeUInt16LE(value, index * 2));
    return new TransactionInstruction({ programId: SAFE_PROGRAM,
      keys: [{ pubkey: owner, isSigner: true, isWritable: false }, { pubkey: safeAddress(owner), isSigner: false, isWritable: true }],
      data: Buffer.concat([instructionTag('set_allocation'), data]),
    });
  };
  return { before: [instruction([0,10_000,0,0,0,0,0,0])], after: [instruction(allocationBpsAfter)], allocationBpsAfter };
}
