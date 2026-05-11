import {
  ComputeBudgetProgram,
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

// Default priority fee for any tx that doesn't already declare one. 50_000
// micro-lamports/CU × 1_400_000 CU = 70_000_000 micro-lamports = 70_000
// lamports = 0.00007 SOL (~$0.015 at $200 SOL). Cheap enough for routine
// vault ops, big enough that mainnet validators won't drop us when leaders
// are busy.
const DEFAULT_PRIORITY_FEE_MICROLAMPORTS = 50_000;

// Discriminator for ComputeBudgetProgram::SetComputeUnitPrice. We use this
// to detect callers that already declared a priority fee so we don't
// stack a duplicate (Solana only honours the last one anyway, but the
// duplicate eats CU and bytes).
const SET_COMPUTE_UNIT_PRICE_DISCRIMINATOR = 3;

const SEND_MAX_ATTEMPTS = 3;

// Soft minimum balance for the agent's authority wallet. Below this we
// can't reliably cover (fee + priority fee + Jupiter Lend setup rent like
// InitTickIdLiquidation accounts). The runtime post-execution check fails
// with "Transaction results in an account (0) with insufficient funds for
// rent" — opaque if you don't know it's about the fee payer. Pre-check
// here so the user gets a clear, actionable message.
const MIN_AUTHORITY_LAMPORTS = 5_000_000; // 0.005 SOL

function isBlockHeightExceeded(err: unknown): boolean {
  const txt = typeof err === "string" ? err : JSON.stringify(err);
  return /block ?height exceeded|TransactionExpiredBlockheightExceeded/i.test(txt);
}

function ensurePriorityFee(ixs: TransactionInstruction[]): TransactionInstruction[] {
  const alreadyHasPrice = ixs.some(
    (ix) =>
      ix.programId.equals(ComputeBudgetProgram.programId) &&
      ix.data.length > 0 &&
      ix.data[0] === SET_COMPUTE_UNIT_PRICE_DISCRIMINATOR,
  );
  if (alreadyHasPrice) return ixs;
  return [
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: DEFAULT_PRIORITY_FEE_MICROLAMPORTS,
    }),
    ...ixs,
  ];
}

async function getLatestBlockhashWithRetry(
  connection: Connection,
): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await connection.getLatestBlockhash("confirmed");
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error(`failed to get recent blockhash after 3 attempts: ${lastErr}`);
}

interface SingleAttemptResult {
  signature: string;
  err: unknown;
}

async function signAndSendOnce(
  connection: Connection,
  authority: Keypair,
  ixs: TransactionInstruction[],
  alts: AddressLookupTableAccount[],
): Promise<SingleAttemptResult> {
  const latest = await getLatestBlockhashWithRetry(connection);

  let tx: VersionedTransaction;
  try {
    const message = new TransactionMessage({
      payerKey: authority.publicKey,
      recentBlockhash: latest.blockhash,
      instructions: ixs,
    }).compileToV0Message(alts);

    tx = new VersionedTransaction(message);
    tx.sign([authority]);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      signature: "",
      err: {
        message: msg,
        phase: "compile_or_sign",
        instructionCount: ixs.length,
        altCount: alts.length,
        signerKeys: ixs
          .flatMap((ix) => ix.keys.filter((key) => key.isSigner).map((key) => key.pubkey.toBase58()))
          .filter((value, index, arr) => arr.indexOf(value) === index),
      },
    };
  }

  let signature = "";
  try {
    signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 5,
    });
  } catch (e: unknown) {
    if (e instanceof SendTransactionError) {
      const logs = await e.getLogs(connection).catch(() => null);
      return {
        signature: "",
        err: { name: e.name, message: e.message, logs },
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { signature: "", err: { message: msg } };
  }

  try {
    const confirmation = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
    return { signature, err: confirmation.value.err };
  } catch (e: unknown) {
    // The tx might have actually landed even though the websocket dropped.
    // Probe signature status before deciding it's a failure.
    const statuses = await connection.getSignatureStatuses([signature]).catch(() => null);
    const status = statuses?.value[0];
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return { signature, err: status.err ?? null };
    }
    if (status?.err) {
      return { signature, err: status.err };
    }
    if (e instanceof SendTransactionError) {
      const logs = await e.getLogs(connection).catch(() => null);
      return {
        signature,
        err: { name: e.name, message: e.message, logs },
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { signature, err: { message: msg } };
  }
}

export async function signAndSendTx(params: SignAndSendParams): Promise<SendResult> {
  const { connection, authority, ixs, alts } = params;

  // Authority balance pre-check. Failing here gives a clear, actionable
  // error ("send SOL to <pubkey>") instead of a downstream simulation
  // error like "Transaction results in an account (0) with insufficient
  // funds for rent", which is opaque to anyone who doesn't know that
  // account (0) means the fee payer.
  try {
    const balance = await connection.getBalance(authority.publicKey, "confirmed");
    if (balance < MIN_AUTHORITY_LAMPORTS) {
      const have = (balance / 1_000_000_000).toFixed(6);
      const need = (MIN_AUTHORITY_LAMPORTS / 1_000_000_000).toFixed(6);
      return {
        signature: "",
        err: {
          phase: "authority_balance_check",
          message:
            `Agent authority wallet ${authority.publicKey.toBase58()} has only ` +
            `${have} SOL (needs ≥ ${need} SOL to cover tx fee + priority fee + ` +
            `Jupiter Lend setup rent like InitTickIdLiquidation). ` +
            `Send 0.01–0.05 SOL to that address and retry.`,
          authorityPubkey: authority.publicKey.toBase58(),
          authorityLamports: balance,
          requiredLamports: MIN_AUTHORITY_LAMPORTS,
        },
      };
    }
  } catch {
    // RPC hiccup on balance fetch — non-fatal. Fall through to the send
    // path; the underlying error will surface there if balance is truly
    // the issue.
  }

  const usableAlts = (alts ?? []).filter(
    (alt): alt is AddressLookupTableAccount =>
      Boolean(alt && alt.key && alt.state && Array.isArray(alt.state.addresses)),
  );

  const ixsWithFee = ensurePriorityFee(ixs);

  // Outer retry loop. Block-height-exceeded is a transient mainnet
  // condition: the tx was signed with a blockhash that expired before
  // leaders picked it up. Refreshing the blockhash and re-signing is
  // the standard recovery — RPC-level `maxRetries` can't help because
  // it re-broadcasts the same signed bytes.
  let lastResult: SingleAttemptResult = { signature: "", err: null };
  for (let attempt = 0; attempt < SEND_MAX_ATTEMPTS; attempt++) {
    lastResult = await signAndSendOnce(connection, authority, ixsWithFee, usableAlts);
    if (!lastResult.err) return lastResult;
    if (!isBlockHeightExceeded(lastResult.err)) return lastResult;

    // Last-chance check: maybe the tx actually landed since the timeout.
    if (lastResult.signature) {
      const probe = await connection
        .getSignatureStatuses([lastResult.signature])
        .catch(() => null);
      const status = probe?.value[0];
      if (
        status &&
        (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") &&
        !status.err
      ) {
        return { signature: lastResult.signature, err: null };
      }
    }
    // Pause briefly so we don't refetch the same blockhash.
    await new Promise((r) => setTimeout(r, 750));
  }

  return lastResult;
}

