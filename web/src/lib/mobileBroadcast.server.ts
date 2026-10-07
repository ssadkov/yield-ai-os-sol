import { ComputeBudgetProgram, Connection, PublicKey, SendTransactionError, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createHash, createPublicKey, verify } from "node:crypto";
import { MobileApiError } from "./mobileSafe.ts";
const allowed = new Set(["initialize_with_limits", "deposit", "withdraw", "set_allocation", "kamino_deposit", "kamino_withdraw", "init_exponent_position", "exponent_buy_pt", "exponent_sell_pt", "exponent_redeem_pt"].map(name => createHash("sha256").update("global:" + name).digest().subarray(0,8).toString("hex")));
export const LIGHTHOUSE_PROGRAM = new PublicKey("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
export const MAX_COMPUTE_UNIT_PRICE = BigInt(500_000); // micro-lamports/CU; <= 0.0007 SOL priority at 1.4M CU.
function invalid(message: string): never { throw new MobileApiError("INVALID_TRANSACTION", message); }
function validateBudget(ix: TransactionInstruction) {
  if (ix.keys.length || !ix.data.length) invalid("Malformed compute budget instruction");
  const tag = ix.data[0];
  if (tag === 3) {
    if (ix.data.length !== 9 || ix.data.readBigUInt64LE(1) > MAX_COMPUTE_UNIT_PRICE) invalid("Compute unit price exceeds transport limit");
  } else if ([1, 2, 4].includes(tag)) {
    if (ix.data.length !== 5) invalid("Malformed compute budget instruction");
    const value = ix.data.readUInt32LE(1);
    if (tag === 2 && (!value || value > 1_400_000)) invalid("Compute unit limit exceeds transport limit");
    if (tag === 1 && (value < 32_768 || value > 262_144 || value % 1024)) invalid("Invalid heap frame");
    if (tag === 4 && (!value || value > 67_108_864)) invalid("Invalid loaded accounts data limit");
  } else invalid("Unsupported compute budget instruction");
}
function validateLighthouse(ix: TransactionInstruction) {
  // Reviewed public SDK discriminator 6 = AssertAccountInfoMulti, one target account.
  // Verified unsigned against Mainnet: prefixes 06 04 and 06 05 pass; a false assertion fails.
  // MemoryWrite/MemoryClose and every other unreviewed discriminator remain rejected.
  // Writability/signership is message-global: assertions may observe the owner or writable Safe.
  if (ix.data.length < 3 || ix.data[0] !== 6 || ix.keys.length !== 1) invalid("Only Lighthouse account-info assertions are supported");
  // The remaining assertion/log-level encoding is decoded by mandatory RPC preflight, never by the transport.
}
export async function validateMobileBroadcast(connection: Connection, network: { programId: string }, wire: Buffer) {
  if (wire.length > 1232) invalid("Transaction exceeds packet size");
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(wire); } catch { return invalid("Malformed transaction"); }
  if (tx.version !== 0 || tx.message.header.numRequiredSignatures !== 1 || tx.signatures[0].every(b => b === 0) || tx.message.addressTableLookups.length > 4) invalid("Expected one signed owner v0 transaction");
  const payer = tx.message.staticAccountKeys[0];
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), payer.toBuffer()]), format: "der", type: "spki" });
  if (!verify(null, tx.message.serialize(), publicKey, tx.signatures[0])) invalid("Invalid owner signature");
  const tables = await Promise.all(tx.message.addressTableLookups.map(async l => {
    const table = (await connection.getAddressLookupTable(l.accountKey)).value;
    if (!table || !table.isActive()) throw new MobileApiError("INVALID_TRANSACTION", "Inactive lookup table");
    return table;
  }));
  let message: TransactionMessage;
  try { message = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tables }); }
  catch { return invalid("Malformed transaction account indices"); }
  const program = new PublicKey(network.programId);
  let safeActions = 0;
  for (const ix of message.instructions) {
    if (ix.programId.equals(ComputeBudgetProgram.programId)) { validateBudget(ix); continue; }
    if (ix.programId.equals(LIGHTHOUSE_PROGRAM)) { validateLighthouse(ix); continue; }
    if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) continue;
    if (!ix.programId.equals(program) || !allowed.has(ix.data.subarray(0,8).toString("hex"))) invalid("Transport supports reviewed Safe operations only");
    if (!ix.keys[0]?.isSigner || !ix.keys[0].pubkey.equals(payer)) invalid("Safe authority must be the owner fee payer");
    safeActions++;
  }
  if (!safeActions) invalid("Missing Safe operation");
}
export async function submitMobileBroadcast(connection: Connection, network: { programId: string }, wire: Buffer) {
  await validateMobileBroadcast(connection, network, wire);
  try {
    return await connection.sendRawTransaction(wire, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 2 });
  } catch (error) {
    // web3 throws this only for an explicit sendTransaction RPC error response (preflight is always on).
    // Unknown provider/network failures remain 503: a submission might have reached the network.
    if (error instanceof SendTransactionError) throw new MobileApiError("SIMULATION_FAILED", "Transaction rejected by RPC preflight; nothing submitted", 422);
    throw error;
  }
}
