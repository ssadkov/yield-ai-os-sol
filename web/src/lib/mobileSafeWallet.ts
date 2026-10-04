import { BN, BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import { Buffer } from "buffer";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import idl from "../idl/yield_vault_mobile.json" with { type: "json" };

import { MOBILE_NETWORKS } from "./mobileNetworks.ts";
const REVIEWED_EXECUTOR = new PublicKey("3ayNPp7MoihfbnTQ4q6Ge5PVNe9tJsY5betKqKX7C8aH");
export type MobileAction = "create" | "create_deposit" | "deposit" | "withdraw";
export type MobilePlan = {
  status: string; blockhash: string; lastValidBlockHeight: number;
  cost: { totalLamports: string; rentLamports: string; networkFeeLamports: string };
  amountRaw?: string; initialDepositRaw?: string;
  steps: { transaction: string }[];
  state: { network: { genesis: string; cluster: string; programId: string; usdcMint: string }; safe: string; idleUsdc: string };
};
const coder = new BorshInstructionCoder(idl as Idl);
function rawAmount(value: string) {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value)) throw Error("Invalid USDC amount");
  const [whole, fraction = ""] = value.split(".");
  const raw = BigInt(whole) * BigInt(1_000_000) + BigInt(fraction.padEnd(6, "0"));
  if (raw <= BigInt(0) || raw > (BigInt(1) << BigInt(64)) - BigInt(1)) throw Error("Invalid USDC amount");
  return String(raw);
}
/** Reconstruct the requested transaction locally; reject additional programs or changed accounts/data. */
export function checkedMobileTransaction(plan: MobilePlan, owner: PublicKey, action: MobileAction, requested: string, cluster: keyof typeof MOBILE_NETWORKS) {
  const network = MOBILE_NETWORKS[cluster];
  const program = new PublicKey(network.programId);
  const mint = new PublicKey(network.usdcMint);
  const n = plan.state.network;
  if (n.cluster !== network.cluster || n.genesis !== network.genesis || n.programId !== network.programId || n.usdcMint !== network.usdcMint) throw Error("Not the reviewed Solana cluster/program/mint");
  const [safe] = PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.toBytes()], program);
  const [registry] = PublicKey.findProgramAddressSync([Buffer.from("executor_registry")], program);
  const [limits] = PublicKey.findProgramAddressSync([Buffer.from("executor_limits"), safe.toBytes()], program);
  const ata = getAssociatedTokenAddressSync(mint, safe, true);
  const ownerAta = getAssociatedTokenAddressSync(mint, owner);
  if (String(safe) !== plan.state.safe || plan.steps.length !== 1) throw Error("Safe/step mismatch");
  const wire = Buffer.from(plan.steps[0].transaction, "base64");
  const tx = VersionedTransaction.deserialize(wire);
  if (wire.length > 1232 || tx.version !== 0 || tx.message.addressTableLookups.length || tx.message.header.numRequiredSignatures !== 1 || !tx.message.staticAccountKeys[0].equals(owner) || tx.message.recentBlockhash !== plan.blockhash || tx.signatures.some(s => s.some(b => b))) throw Error("Unexpected transaction envelope");
  const instructions = TransactionMessage.decompile(tx.message).instructions;
  const expected = [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })];
  if (action.startsWith("create")) expected.push(new TransactionInstruction({ programId: program, data: coder.encode("initialize_with_limits", { agent: REVIEWED_EXECUTOR, allocation_bps: Array(8).fill(0), allowed_programs: [] }), keys: [
    { pubkey: owner, isSigner: true, isWritable: true }, { pubkey: safe, isSigner: false, isWritable: true }, { pubkey: registry, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: ata, isSigner: false, isWritable: true }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: limits, isSigner: false, isWritable: true },
  ] }));
  if (action === "create_deposit" || action === "deposit" || action === "withdraw") {
    const amount = rawAmount(requested === "all" && action === "withdraw" ? plan.state.idleUsdc : requested);
    if ((action === "create_deposit" ? plan.initialDepositRaw : plan.amountRaw) !== amount) throw Error("Amount mismatch");
    const kind = action === "withdraw" ? "withdraw" : "deposit";
    // Only canonical idempotent ATA recreation is allowed before the typed transfer.
    if (!action.startsWith("create") && instructions.length === 3) expected.push(createAssociatedTokenAccountIdempotentInstruction(owner, kind === "withdraw" ? ownerAta : ata, kind === "withdraw" ? owner : safe, mint));
    expected.push(new TransactionInstruction({ programId: program, data: coder.encode(kind, { amount: new BN(amount) }), keys: [
      { pubkey: owner, isSigner: true, isWritable: true }, { pubkey: safe, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: ownerAta, isSigner: false, isWritable: true }, { pubkey: ata, isSigner: false, isWritable: true }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ] }));
  }
  // Message-wide writable promotion is normal when initialization and deposit share an account.
  const rebuilt = new TransactionMessage({ payerKey: owner, recentBlockhash: plan.blockhash, instructions: expected }).compileToV0Message();
  if (!Buffer.from(rebuilt.serialize()).equals(Buffer.from(tx.message.serialize()))) throw Error("Transaction differs from the requested operation");
  return tx;
}
