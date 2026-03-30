import {
  Connection,
  PublicKey,
  type ConfirmedSignatureInfo,
} from "@solana/web3.js";
import bs58 from "bs58";

const USDC_DECIMALS = 6;

const DEPOSIT_DISC = Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]);
const WITHDRAW_DISC = Buffer.from([183, 18, 70, 156, 148, 109, 161, 34]);

export interface VaultTxEntry {
  signature: string;
  type: "deposit" | "withdraw";
  amountRaw: string;
  amountUsdc: number;
  timestamp: number | null;
}

export interface VaultPnlData {
  entries: VaultTxEntry[];
  totalDeposited: number;
  totalWithdrawn: number;
  netDeposited: number;
}

function matchDiscriminator(
  data: Uint8Array,
  disc: Buffer,
): boolean {
  if (data.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (data[i] !== disc[i]) return false;
  }
  return true;
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset + offset, 8);
  return view.getBigUint64(0, true);
}

/**
 * Fetches all deposit/withdraw transactions for a vault PDA from chain,
 * parsing the Anchor instruction discriminators to identify each type.
 */
export async function fetchVaultHistory(
  connection: Connection,
  programId: PublicKey,
  vaultPda: PublicKey,
): Promise<VaultPnlData> {
  const allSigs: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;

  for (;;) {
    const batch = await connection.getSignaturesForAddress(vaultPda, {
      before,
      limit: 1000,
    });
    if (batch.length === 0) break;
    allSigs.push(...batch);
    before = batch[batch.length - 1].signature;
    if (batch.length < 1000) break;
  }

  const entries: VaultTxEntry[] = [];
  const BATCH_SIZE = 30;

  for (let i = 0; i < allSigs.length; i += BATCH_SIZE) {
    const batch = allSigs.slice(i, i + BATCH_SIZE);
    const txResults = await Promise.allSettled(
      batch.map((s) =>
        connection.getParsedTransaction(s.signature, {
          maxSupportedTransactionVersion: 0,
        }),
      ),
    );

    for (let j = 0; j < txResults.length; j++) {
      const result = txResults[j];
      if (result.status !== "fulfilled" || !result.value) continue;
      const tx = result.value;
      if (tx.meta?.err) continue;

      const sigInfo = batch[j];

      for (const ix of tx.transaction.message.instructions) {
        if (!("data" in ix) || !ix.programId.equals(programId)) continue;

        let data: Uint8Array;
        try {
          data = bs58.decode(ix.data);
        } catch {
          continue;
        }
        if (data.length < 16) continue;

        const amount = readU64LE(data, 8);
        const amountUsdc = Number(amount) / 10 ** USDC_DECIMALS;

        if (matchDiscriminator(data, DEPOSIT_DISC)) {
          entries.push({
            signature: sigInfo.signature,
            type: "deposit",
            amountRaw: amount.toString(),
            amountUsdc,
            timestamp: sigInfo.blockTime ?? null,
          });
        } else if (matchDiscriminator(data, WITHDRAW_DISC)) {
          entries.push({
            signature: sigInfo.signature,
            type: "withdraw",
            amountRaw: amount.toString(),
            amountUsdc,
            timestamp: sigInfo.blockTime ?? null,
          });
        }
      }
    }
  }

  entries.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

  let totalDeposited = 0;
  let totalWithdrawn = 0;
  for (const e of entries) {
    if (e.type === "deposit") totalDeposited += e.amountUsdc;
    else totalWithdrawn += e.amountUsdc;
  }

  return {
    entries,
    totalDeposited,
    totalWithdrawn,
    netDeposited: totalDeposited - totalWithdrawn,
  };
}
