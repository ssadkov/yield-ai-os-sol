import { PublicKey, VersionedTransaction } from "@solana/web3.js";

/** Accept wallet-specific transaction objects only after re-parsing and verifying their bytes. */
export async function verifyOwnerSignedTransaction(
  serialized: Uint8Array,
  expectedMessage: Uint8Array,
  owner: PublicKey,
): Promise<VersionedTransaction> {
  let signed: VersionedTransaction;
  try {
    signed = VersionedTransaction.deserialize(Uint8Array.from(serialized));
  } catch {
    throw new Error("Wallet returned an unreadable versioned transaction");
  }
  const message = signed.message.serialize();
  if (message.length !== expectedMessage.length
    || message.some((byte, index) => byte !== expectedMessage[index])) {
    throw new Error("Wallet changed the transaction message");
  }
  if (signed.message.header.numRequiredSignatures !== 1 || signed.signatures.length !== 1) {
    throw new Error("Wallet returned an unexpected signer count");
  }
  const signature = signed.signatures[0];
  if (!signature || !signature.some((byte) => byte !== 0)) {
    throw new Error("Wallet returned no owner signature");
  }
  const key = await crypto.subtle.importKey(
    "raw", Uint8Array.from(owner.toBytes()).buffer, "Ed25519", false, ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "Ed25519", key, Uint8Array.from(signature).buffer, Uint8Array.from(message).buffer,
  );
  if (!valid) throw new Error("Wallet signature does not verify for this owner");
  return signed;
}
