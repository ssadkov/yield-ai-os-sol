import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { verifyOwnerSignedTransaction } from "./verifySolanaOwnerSignature.ts";

function signedTransfer(owner, recipient) {
  const message = new TransactionMessage({
    payerKey: owner.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({
      fromPubkey: owner.publicKey, toPubkey: recipient.publicKey, lamports: 1,
    })],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([owner]);
  return transaction;
}

test("accepts a valid owner signature over the exact message bytes", async () => {
  const owner = Keypair.generate();
  const transaction = signedTransfer(owner, Keypair.generate());
  const walletResult = { serialize: () => Uint8Array.from(transaction.serialize()) };
  assert.equal(walletResult instanceof VersionedTransaction, false);
  const verified = await verifyOwnerSignedTransaction(
    walletResult.serialize(), transaction.message.serialize(), owner.publicKey,
  );
  assert.deepEqual(verified.serialize(), transaction.serialize());
});

test("rejects a different signed message even when its signature is valid", async () => {
  const owner = Keypair.generate();
  const expected = signedTransfer(owner, Keypair.generate());
  const changed = signedTransfer(owner, Keypair.generate());
  await assert.rejects(
    verifyOwnerSignedTransaction(changed.serialize(), expected.message.serialize(), owner.publicKey),
    /changed the transaction message/,
  );
});

test("rejects a corrupted owner signature", async () => {
  const owner = Keypair.generate();
  const transaction = signedTransfer(owner, Keypair.generate());
  const corrupted = Uint8Array.from(transaction.serialize());
  corrupted[1] ^= 1;
  await assert.rejects(
    verifyOwnerSignedTransaction(corrupted, transaction.message.serialize(), owner.publicKey),
    /signature does not verify/,
  );
});
