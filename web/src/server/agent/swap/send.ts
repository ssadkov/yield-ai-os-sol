import {
  Connection,
  Keypair,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  SendTransactionError,
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

  let latest: { blockhash: string; lastValidBlockHeight: number } | null = null;
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    try {
      latest = await connection.getLatestBlockhash("confirmed");
      break;
    } catch (err) {
      attempts++;
      if (attempts >= maxAttempts) throw new Error(`failed to get recent blockhash after ${maxAttempts} attempts: ${err}`);
      await new Promise(r => setTimeout(r, 1000 * attempts)); // Exponential backoff-ish
    }
  }

  if (!latest) throw new Error("failed to get recent blockhash (unknown error)");

  const message = new TransactionMessage({
    payerKey: authority.publicKey,
    recentBlockhash: latest.blockhash,
    instructions: ixs,
  }).compileToV0Message(alts);

  const tx = new VersionedTransaction(message);
  tx.sign([authority]);

  let signature = "";
  try {
    signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
  } catch (e: unknown) {
    if (e instanceof SendTransactionError) {
      const logs = await e.getLogs(connection).catch(() => null);
      return {
        signature: "",
        err: {
          name: e.name,
          message: e.message,
          logs,
        },
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { signature: "", err: { message: msg } };
  }

  try {
    const confirmation = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
    return { signature, err: confirmation.value.err };
  } catch (e: unknown) {
    const statuses = await connection.getSignatureStatuses([signature]);
    const status = statuses.value[0];
    if (status?.err) {
      return { signature, err: status.err };
    }
    if (e instanceof SendTransactionError) {
      const logs = await e.getLogs(connection).catch(() => null);
      return {
        signature,
        err: {
          name: e.name,
          message: e.message,
          logs,
        },
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { signature, err: { message: msg } };
  }
}

