/** Manual operator relay. Preflight is unsigned; sending always requires separate approval. */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnchorProvider, Program, Wallet, type Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAccount } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { EVM_DEVNET_PROGRAM as programId, EVM_DEVNET_USDC_MINT as mint, EVM_DEVNET_GENESIS as genesis,
  deriveEvmSafe, decimalU64, validateProbeAllocation, assertCanonicalEvmSignature,
  parseWithdrawalIntent, verifyEvmIntentSignature, isWithdrawalIntent, type EvmOwnerIntent, isLifecycleIntent,
} from "../../web/src/lib/v2EvmDevnet.ts";

const here = dirname(fileURLToPath(import.meta.url));
const idl = JSON.parse(readFileSync(join(here, "../../web/src/idl/yield_vault_evm_devnet.json"), "utf8")) as Idl;
function readIntent(path: string): EvmOwnerIntent {
  const input = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert(input && typeof input === "object" && !Array.isArray(input), "invalid intent JSON");
  if (input.action === "withdraw_usdc") return parseWithdrawalIntent(input);
  assert(input.action === undefined || input.action === "set_allocation", "unsupported intent action");
  assert(typeof input.owner === "string", "invalid EVM owner");
  const { owner, safe } = deriveEvmSafe(input.owner);
  assert.equal(input.safe, safe.toBase58(), "Safe does not match EVM owner");
  assertCanonicalEvmSignature(input.signature);
  return { owner, safe: safe.toBase58(), allocationBps: validateProbeAllocation(input.allocationBps),
    nonce: decimalU64(input.nonce, "nonce").toString(), deadline: decimalU64(input.deadline, "deadline").toString(), signature: input.signature };
}
function existingPayer(): Keypair {
  const path = process.env.V2_PAYER_KEYPAIR;
  if (!path) throw new Error("V2_PAYER_KEYPAIR must point to an existing protected Devnet payer");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path.replace(/^~/, homedir()), "utf8"))));
}
type State = { ethAddress: number[]; nonce: BN; allocationBps: number[] };
async function main() {
  const mode = process.argv[2], path = process.argv[3];
  if ((mode !== "--preflight" && mode !== "--send") || !path) throw new Error("Use --preflight <intent.json> or --send <intent.json>");
  if (mode === "--send" && process.env.V2_EVM_RELAY_ACK !== "APPROVED_DEVNET_EVM_INTENT") throw new Error("Devnet relay send requires transaction-specific acknowledgement");
  assert.equal(idl.address, programId.toBase58(), "Devnet IDL mismatch");
  const intent = readIntent(path), withdraw = isWithdrawalIntent(intent);
  assert(!isLifecycleIntent(intent), "Lifecycle intents use the separately gated relayer lifecycle path");
  const digest = await verifyEvmIntentSignature(intent);
  const { ownerBytes: owner, safe, ata } = deriveEvmSafe(intent.owner);
  const nonce = BigInt(intent.nonce), deadline = BigInt(intent.deadline), now = BigInt(Math.floor(Date.now() / 1000));
  assert(deadline > now && deadline <= now + 900n, "intent expired or deadline too far away");
  const endpoint = process.env.V2_DEVNET_RPC_URL || "https://api.devnet.solana.com";
  assert.equal(new URL(endpoint).protocol, "https:", "Devnet RPC must use HTTPS");
  const connection = new Connection(endpoint, "confirmed");
  assert.equal(await connection.getGenesisHash(), genesis, "RPC is not Solana Devnet");
  const payerPublicKey = new PublicKey(process.env.V2_EVM_ALLOWED_PAYER || "8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A");
  // Unsigned preflight never reads the sponsor secret.
  const payer = mode === "--send" ? existingPayer() : Keypair.generate();
  if (mode === "--send") assert(payer.publicKey.equals(payerPublicKey), "payer does not match the configured Devnet sponsor");
  const program = new Program(idl, new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" }));
  const accounts = program.account as unknown as { evmVault: { fetch(address: PublicKey): Promise<State> } };
  const info = await connection.getAccountInfo(safe, "confirmed"), instructions = [];
  let rent = 0, sourceBefore = 0n, recipientBefore = 0n;
  assert(info && info.owner.equals(programId), "Safe must already exist; creation needs a separate owner-signed lifecycle intent");
  const state = await accounts.evmVault.fetch(safe);
  assert.equal(Buffer.from(state.ethAddress).toString("hex"), Buffer.from(owner).toString("hex"), "Safe owner mismatch");
  assert.equal(nonce, BigInt(state.nonce.toString()) + 1n, "Safe nonce changed; request a fresh signature; never resend blindly");
  const token = await getAccount(connection, ata, "confirmed");
  assert(token.owner.equals(safe) && token.mint.equals(mint) && !token.isFrozen, "Safe USDC ATA mismatch or frozen");
  sourceBefore = token.amount;
  if (isWithdrawalIntent(intent)) {
    const destination = new PublicKey(intent.recipientTokenAccount), authority = new PublicKey(intent.recipientOwner);
    const token = await getAccount(connection, destination, "confirmed");
    assert(token.mint.equals(mint) && token.owner.equals(authority) && !token.isFrozen, "recipient account mint/authority mismatch or frozen");
    assert(BigInt(intent.amountRaw) <= sourceBefore, "insufficient idle USDC");
    recipientBefore = token.amount;
    instructions.push(await program.methods.evmWithdrawUsdc(new BN(intent.amountRaw), new BN(intent.nonce), new BN(intent.deadline), [...Buffer.from(intent.signature.slice(2), "hex")])
      .accountsStrict({ payer: payerPublicKey, evmVault: safe, usdcMint: mint, vaultUsdcAta: ata,
        recipientUsdcAccount: destination, tokenProgram: TOKEN_PROGRAM_ID }).instruction());
  } else {
    instructions.push(await program.methods.evmSetAllocation(intent.allocationBps, new BN(intent.nonce), new BN(intent.deadline), [...Buffer.from(intent.signature.slice(2), "hex")])
      .accountsStrict({ payer: payerPublicKey, evmVault: safe }).instruction());
  }
  const tx = new Transaction().add(...instructions);
  tx.feePayer = payerPublicKey; tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const fee = await connection.getFeeForMessage(tx.compileMessage());
  assert(fee.value !== null && fee.value <= 100_000, "network fee exceeds cap");
  const simulation = await connection.simulateTransaction(tx);
  assert.equal(simulation.value.err, null, `Devnet simulation failed: ${JSON.stringify(simulation.value.err)} ${simulation.value.logs?.join("\n")}`);
  console.log(JSON.stringify({ status: "simulation_ok", cluster: "devnet", program: programId.toBase58(),
    action: withdraw ? "withdraw_usdc" : "set_allocation", payer: payerPublicKey.toBase58(), intent, digest,
    source: ata.toBase58(), rentLamports: rent, feeLamports: fee.value, computeUnits: simulation.value.unitsConsumed }));
  if (mode === "--preflight") return;
  assert(BigInt(Math.floor(Date.now() / 1000)) < deadline, "signature expired during preflight");
  const txSignature = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "finalized", skipPreflight: false });
  // Print the receipt before read-back: a read failure must not hide a sent transaction.
  console.log(JSON.stringify({ status: "finalized", txSignature, digest, safe: safe.toBase58() }));
  const after = await accounts.evmVault.fetch(safe);
  assert.equal(after.nonce.toString(), intent.nonce, "post-send nonce mismatch");
  if (isWithdrawalIntent(intent)) {
    const sourceAfter = await getAccount(connection, ata, "finalized");
    const destinationAfter = await getAccount(connection, new PublicKey(intent.recipientTokenAccount), "finalized");
    assert.equal(sourceAfter.amount, sourceBefore - BigInt(intent.amountRaw), "source balance mismatch");
    assert.equal(destinationAfter.amount, recipientBefore + BigInt(intent.amountRaw), "recipient balance mismatch");
  } else assert(after.allocationBps.every((part, i) => part === intent.allocationBps[i]), "post-send allocation mismatch");
  console.log(JSON.stringify({ status: "readback_ok", txSignature, nonce: after.nonce.toString() }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
