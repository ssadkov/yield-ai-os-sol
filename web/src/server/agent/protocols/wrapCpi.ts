import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { encodeExecuteProtocolCpiData } from "../swap/anchorIx";

export type ProtocolInstructionLike = {
  programId: PublicKey | string;
  keys: {
    pubkey: PublicKey | string;
    isSigner: boolean;
    isWritable: boolean;
  }[];
  data: Uint8Array | Buffer | string;
};

function toPublicKey(value: PublicKey | string): PublicKey {
  return value instanceof PublicKey ? value : new PublicKey(value);
}

function toDataBuffer(data: ProtocolInstructionLike["data"]): Buffer {
  return typeof data === "string" ? Buffer.from(data, "base64") : Buffer.from(data);
}

export function wrapProtocolCpiIx(args: {
  vaultProgramId: PublicKey;
  authority: PublicKey;
  vault: PublicKey;
  inner: ProtocolInstructionLike;
}): TransactionInstruction {
  const innerProgramId = toPublicKey(args.inner.programId);
  const data = encodeExecuteProtocolCpiData(toDataBuffer(args.inner.data));

  const innerKeys = args.inner.keys.map((a) => {
    const pubkey = toPublicKey(a.pubkey);
    const isVaultPda = pubkey.equals(args.vault);
    return {
      pubkey,
      isSigner: isVaultPda ? false : a.isSigner,
      isWritable: a.isWritable,
    };
  });

  return new TransactionInstruction({
    programId: args.vaultProgramId,
    keys: [
      { pubkey: args.authority, isSigner: true, isWritable: true },
      { pubkey: args.vault, isSigner: false, isWritable: true },
      { pubkey: innerProgramId, isSigner: false, isWritable: false },
      ...innerKeys,
    ],
    data,
  });
}
