import {
  Connection,
  Keypair,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from "@solana/web3.js";

export interface SignAndSendParams {
  connection: Connection;
  authority: Keypair;
  ixs: TransactionInstruction[];
  alts: AddressLookupTableAccount[];
}

export interface SendResult {
  signature: string;
  err: unknown;
}

export async function signAndSendTx(params: SignAndSendParams): Promise<SendResult> {
  const { connection, authority, ixs, alts } = params;

  const latest = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: authority.publicKey,
    recentBlockhash: latest.blockhash,
    instructions: ixs,
  }).compileToV0Message(alts);

  const tx = new VersionedTransaction(message);
  tx.sign([authority]);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  try {
    const confirmation = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
    return { signature, err: confirmation.value.err };
  } catch (e: unknown) {
    const statuses = await connection.getSignatureStatuses([signature]);
    const status = statuses.value[0];
    if (status?.err) {
      return { signature, err: status.err };
    }
    throw e;
  }
}

