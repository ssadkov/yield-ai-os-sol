import { PublicKey } from "@solana/web3.js";

const EXECUTE_SWAP_CPI_DISCRIMINATOR = Uint8Array.from([237, 131, 174, 182, 85, 20, 137, 90]);
const EXECUTE_PROTOCOL_CPI_DISCRIMINATOR = Uint8Array.from([255, 29, 92, 60, 105, 188, 32, 11]);

export function encodeExecuteSwapCpiData(innerIxData: Uint8Array): Buffer {
  return encodeCpiData(EXECUTE_SWAP_CPI_DISCRIMINATOR, innerIxData);
}

export function encodeExecuteProtocolCpiData(innerIxData: Uint8Array): Buffer {
  return encodeCpiData(EXECUTE_PROTOCOL_CPI_DISCRIMINATOR, innerIxData);
}

function encodeCpiData(discriminator: Uint8Array, innerIxData: Uint8Array): Buffer {
  const len = innerIxData.length;
  const out = Buffer.alloc(8 + 4 + len);
  Buffer.from(discriminator).copy(out, 0);
  out.writeUInt32LE(len, 8);
  Buffer.from(innerIxData).copy(out, 12);
  return out;
}

export function deriveVaultPda(programId: PublicKey, owner: PublicKey): PublicKey {
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.toBuffer()], programId);
  return vault;
}

