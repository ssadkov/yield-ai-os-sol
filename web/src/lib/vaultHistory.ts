import {
  Connection,
  PublicKey,
  type ConfirmedSignatureInfo,
} from "@solana/web3.js";
import bs58 from "bs58";

const USDC_DECIMALS = 6;
const USDC_MINT_STR = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const DEPOSIT_DISC = Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]);
const WITHDRAW_DISC = Buffer.from([183, 18, 70, 156, 148, 109, 161, 34]);
const DEPOSIT_SPL_DISC = Buffer.from([224, 0, 198, 175, 198, 47, 105, 204]);
const WITHDRAW_SPL_DISC = Buffer.from([181, 154, 94, 86, 62, 115, 6, 186]);

export interface VaultTxEntry {
  signature: string;
  type: "deposit" | "withdraw";
  amountRaw: string;
  /** USD-denominated amount; for non-USDC deposits this is null until the
   *  client applies a live price (handled in useVaultPnl). */
  amountUsdc: number | null;
  /** Mint of the deposited token. For legacy USDC deposit/withdraw ixs this
   *  is always USDC; for deposit_spl / withdraw_spl it's the actual mint. */
  mint: string;
  /** Token decimals — needed to convert raw amount to UI amount for non-USDC. */
  decimals: number;
  timestamp: number | null;
}

export interface VaultPnlData {
  entries: VaultTxEntry[];
  /** Sum in USDC (USDC-mint deposits only). */
  totalDeposited: number;
  totalWithdrawn: number;
  netDeposited: number;
  /** True if the vault has any non-USDC deposit/withdraw history. Without
   *  live prices for those mints the USD-denominated netDeposited is
   *  incomplete, and the client should surface PnL with a caveat. */
  hasSplActivity: boolean;
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
  // Keep RPC concurrency conservative (Helius free tier is low RPS).
  // This used to be 30 and easily triggers 429 bursts.
  const BATCH_SIZE = 8;

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

        // Anchor instruction account index where the mint lives.
        // deposit / withdraw (USDC-only): owner, vault, usdc_mint, owner_ata, vault_ata
        // deposit_spl / withdraw_spl:     owner, vault, mint,      owner_ata, vault_ata
        // → mint is at index 2 in both layouts.
        const accountKeys = (ix as { accounts?: Array<PublicKey | string> }).accounts ?? [];
        const mintKey = accountKeys[2];
        const mintStr =
          typeof mintKey === "string"
            ? mintKey
            : mintKey instanceof PublicKey
              ? mintKey.toBase58()
              : USDC_MINT_STR;

        let type: "deposit" | "withdraw" | null = null;
        let decimals = USDC_DECIMALS;
        let amountUsdc: number | null = null;

        if (matchDiscriminator(data, DEPOSIT_DISC)) {
          type = "deposit";
          decimals = USDC_DECIMALS;
          amountUsdc = Number(amount) / 10 ** USDC_DECIMALS;
        } else if (matchDiscriminator(data, WITHDRAW_DISC)) {
          type = "withdraw";
          decimals = USDC_DECIMALS;
          amountUsdc = Number(amount) / 10 ** USDC_DECIMALS;
        } else if (matchDiscriminator(data, DEPOSIT_SPL_DISC)) {
          type = "deposit";
          decimals = mintStr === USDC_MINT_STR ? USDC_DECIMALS : 8; // best-effort default
          amountUsdc = mintStr === USDC_MINT_STR ? Number(amount) / 10 ** USDC_DECIMALS : null;
        } else if (matchDiscriminator(data, WITHDRAW_SPL_DISC)) {
          type = "withdraw";
          decimals = mintStr === USDC_MINT_STR ? USDC_DECIMALS : 8;
          amountUsdc = mintStr === USDC_MINT_STR ? Number(amount) / 10 ** USDC_DECIMALS : null;
        }

        if (!type) continue;
        entries.push({
          signature: sigInfo.signature,
          type,
          amountRaw: amount.toString(),
          amountUsdc,
          mint: mintStr,
          decimals,
          timestamp: sigInfo.blockTime ?? null,
        });
      }
    }
  }

  entries.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

  let totalDeposited = 0;
  let totalWithdrawn = 0;
  let hasSplActivity = false;
  for (const e of entries) {
    if (e.mint !== USDC_MINT_STR) hasSplActivity = true;
    if (e.amountUsdc != null) {
      if (e.type === "deposit") totalDeposited += e.amountUsdc;
      else totalWithdrawn += e.amountUsdc;
    }
  }

  return {
    entries,
    totalDeposited,
    totalWithdrawn,
    netDeposited: totalDeposited - totalWithdrawn,
    hasSplActivity,
  };
}
