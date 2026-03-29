import { PublicKey } from "@solana/web3.js";

const EXECUTE_SWAP_CPI_DISCRIMINATOR = Uint8Array.from([
  237, 131, 174, 182, 85, 20, 137, 90,
]);

export function encodeExecuteSwapCpiData(innerIxData: Uint8Array): Buffer {
  const len = innerIxData.length;
  const out = Buffer.alloc(8 + 4 + len);
  Buffer.from(EXECUTE_SWAP_CPI_DISCRIMINATOR).copy(out, 0);
  out.writeUInt32LE(len, 8);
  Buffer.from(innerIxData).copy(out, 12);
  return out;
}

export function deriveVaultPda(programId: PublicKey, owner: PublicKey): PublicKey {
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer()],
    programId
  );
  return vault;
}

