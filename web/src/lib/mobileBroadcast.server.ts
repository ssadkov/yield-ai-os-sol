import { ComputeBudgetProgram, Connection, PublicKey, SendTransactionError, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createHash, createPublicKey, verify } from "node:crypto";
import { MobileApiError } from "./mobileSafe.ts";
const allowed = new Set(["initialize_with_limits", "deposit", "withdraw", "set_allocation", "kamino_deposit", "kamino_withdraw", "init_exponent_position", "exponent_buy_pt", "exponent_sell_pt", "exponent_redeem_pt"].map(name => createHash("sha256").update("global:" + name).digest().subarray(0,8).toString("hex")));
export const LIGHTHOUSE_PROGRAM = new PublicKey("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
export const MAX_PRIORITY_FEE_LAMPORTS = BigInt(1_000_000); // 0.001 SOL priority, excluding base fee and rent.
function invalid(message: string): never { throw new MobileApiError("INVALID_TRANSACTION", message); }
function validateBudget(ix: TransactionInstruction) {
  if (ix.keys.length || !ix.data.length) invalid("Malformed compute budget instruction");
  const tag = ix.data[0];
  if (tag === 3) {
    if (ix.data.length !== 9) invalid("Malformed compute unit price instruction");
  } else if ([1, 2, 4].includes(tag)) {
    if (ix.data.length !== 5) invalid("Malformed compute budget instruction");
    const value = ix.data.readUInt32LE(1);
    if (tag === 2 && (!value || value > 1_400_000)) invalid("Compute unit limit exceeds transport limit");
    if (tag === 1 && (value < 32_768 || value > 262_144 || value % 1024)) invalid("Invalid heap frame");
    if (tag === 4 && (!value || value > 67_108_864)) invalid("Invalid loaded accounts data limit");
  } else invalid("Unsupported compute budget instruction");
}
// Pinned source review: Jac0xb/lighthouse 4c579479c98635e419b1b167f08be02a71604a71.
const LIGHTHOUSE_ASSERTIONS = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
const LIGHTHOUSE_COMPRESSION_PROGRAM = new PublicKey("cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK");
function validateLighthouse(ix: TransactionInstruction) {
  if (ix.data.length < 3) invalid("Malformed Lighthouse assertion");
  const tag = ix.data[0];
  // 0/1 allocate/write/close memory; unknown future commands require another source review.
  if (!LIGHTHOUSE_ASSERTIONS.has(tag)) invalid("Unsupported Lighthouse instruction; assertions only");
  // Delta reads two accounts, Clock reads the sysvar internally, Merkle includes proof accounts.
  const accountCount = tag === 4 ? 2 : tag === 15 ? 0 : 1;
  if (tag === 16) {
    if (ix.keys.length < 3 || !ix.keys[2].pubkey.equals(LIGHTHOUSE_COMPRESSION_PROGRAM))
      invalid("Invalid Lighthouse Merkle assertion accounts");
  } else if (ix.keys.length !== accountCount) invalid("Invalid Lighthouse assertion account count");
  // Writability/signership is message-global: assertions may observe the owner or writable Safe.
  // Mandatory preflight decodes/evaluates the full assertion body; signed bytes are never rewritten.
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
  const budgetTypes = new Set<number>();
  let computeUnitLimit = BigInt(1_400_000); // Conservative upper bound when the wallet omits an explicit limit.
  let computeUnitPrice = BigInt(0);
  for (const ix of message.instructions) {
    if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      validateBudget(ix);
      const type = ix.data[0];
      if (budgetTypes.has(type)) invalid("Duplicate compute budget instruction");
      budgetTypes.add(type);
      if (type === 2) computeUnitLimit = BigInt(ix.data.readUInt32LE(1));
      if (type === 3) computeUnitPrice = ix.data.readBigUInt64LE(1);
      continue;
    }
    if (ix.programId.equals(LIGHTHOUSE_PROGRAM)) { validateLighthouse(ix); continue; }
    if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) continue;
    if (!ix.programId.equals(program) || !allowed.has(ix.data.subarray(0,8).toString("hex"))) invalid("Transport supports reviewed Safe operations only");
    if (!ix.keys[0]?.isSigner || !ix.keys[0].pubkey.equals(payer)) invalid("Safe authority must be the owner fee payer");
    safeActions++;
  }
  if (!safeActions) invalid("Missing Safe operation");
  // Solana charges for the requested CU limit, not units actually consumed. Round up using integers.
  const priorityFee = (computeUnitPrice * computeUnitLimit + BigInt(999_999)) / BigInt(1_000_000);
  if (priorityFee > MAX_PRIORITY_FEE_LAMPORTS) throw new MobileApiError("INVALID_TRANSACTION", "Priority fee exceeds transport limit", 400, {
    priorityFeeLamports: priorityFee.toString(), maxPriorityFeeLamports: MAX_PRIORITY_FEE_LAMPORTS.toString(),
    computeUnitPriceMicroLamports: computeUnitPrice.toString(), computeUnitLimit: computeUnitLimit.toString(),
    conservativeLimit: !budgetTypes.has(2),
  });
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
