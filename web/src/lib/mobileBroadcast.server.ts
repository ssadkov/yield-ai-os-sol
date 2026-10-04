import { ComputeBudgetProgram, Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createHash } from "node:crypto";
import { MobileApiError } from "./mobileSafe.ts";
const allowed = new Set(["initialize_with_limits", "deposit", "withdraw", "set_allocation", "kamino_deposit", "kamino_withdraw", "init_exponent_position", "exponent_buy_pt", "exponent_sell_pt", "exponent_redeem_pt"].map(name => createHash("sha256").update("global:" + name).digest().subarray(0,8).toString("hex")));
export async function validateMobileBroadcast(connection: Connection, network: { programId: string }, wire: Buffer) {
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(wire); } catch { throw new MobileApiError("INVALID_TRANSACTION", "Malformed transaction"); }
  if (tx.version !== 0 || tx.message.header.numRequiredSignatures !== 1 || tx.signatures[0].every(b => b === 0) || tx.message.addressTableLookups.length > 4) throw new MobileApiError("INVALID_TRANSACTION", "Expected one signed owner v0 transaction");
  const tables = await Promise.all(tx.message.addressTableLookups.map(async l => {
    const table = (await connection.getAddressLookupTable(l.accountKey)).value;
    if (!table || !table.isActive()) throw new MobileApiError("INVALID_TRANSACTION", "Inactive lookup table");
    return table;
  }));
  const message = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tables });
  const program = new PublicKey(network.programId);
  let safeActions = 0;
  for (const ix of message.instructions) {
    if (ix.programId.equals(ComputeBudgetProgram.programId) || ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) continue;
    if (!ix.programId.equals(program) || !allowed.has(ix.data.subarray(0,8).toString("hex"))) throw new MobileApiError("INVALID_TRANSACTION", "Transport supports reviewed Safe operations only");
    safeActions++;
  }
  if (!safeActions) throw new MobileApiError("INVALID_TRANSACTION", "Missing Safe operation");
}
