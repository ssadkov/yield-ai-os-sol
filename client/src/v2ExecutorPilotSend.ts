/** One-shot Mainnet executor pilot. Run only after a separately reviewed simulation and approval. */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import anchor, { type Idl } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { buildPilotDeposit } from "./v2ExecutorSimulate.ts";
const { BorshAccountsCoder, utils } = anchor;

const PROGRAM = new PublicKey("yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih");
const OWNER = new PublicKey("EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2");
const SAFE = new PublicKey("FuDCEZBgp8gxP3gafnHbUJRgGW63VAmtZwsjus1U5qSZ");
const EXECUTOR = new PublicKey("3ayNPp7MoihfbnTQ4q6Ge5PVNe9tJsY5betKqKX7C8aH");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SHARES = new PublicKey("B9t9wg8r39Lxm2D9Gmqn2rJ5pVQQwjtGBfSsHAXSEnVe");
const FEE_CAP_LAMPORTS = 200_000;

async function main() {
  if (process.argv.slice(2).join(" ") !== "--send-1-usdc-mainnet" ||
      process.env.V2_PILOT_SEND_ACK !== "I_APPROVE_1_USDC_MAINNET_EXECUTOR_DEPOSIT") {
    throw new Error("Explicit one-shot Mainnet send flag and acknowledgement required");
  }
  const signerPath = process.env.V2_EXECUTOR_KEYPAIR;
  if (!signerPath) throw new Error("Set V2_EXECUTOR_KEYPAIR to the existing protected signer file path");
  if ((statSync(signerPath).mode & 0o077) !== 0) throw new Error("Executor signer file must not be group/world-readable");
  const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(signerPath, "utf8"))));
  if (!signer.publicKey.equals(EXECUTOR)) throw new Error("Signer does not match the pilot Safe executor");

  const { connection, message, tx, blockhash } = await buildPilotDeposit();
  const [derivedSafe] = PublicKey.findProgramAddressSync([Buffer.from("vault"), OWNER.toBuffer()], PROGRAM);
  if (!derivedSafe.equals(SAFE)) throw new Error("Pilot Safe PDA mismatch");
  const safeInfo = await connection.getAccountInfo(SAFE, "finalized");
  if (!safeInfo || !safeInfo.owner.equals(PROGRAM)) throw new Error("Pilot Safe missing or wrong program owner");
  const idl = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../web/src/idl/yield_vault.json"), "utf8")) as Idl;
  const vault = new BorshAccountsCoder(idl).decode("Vault", safeInfo.data) as {
    owner: PublicKey; agent: PublicKey; allocation_bps: number[]; route_principal: { toString(): string }[];
  };
  if (!vault.owner.equals(OWNER) || !vault.agent.equals(EXECUTOR) ||
      vault.allocation_bps[0] !== 5_000 || vault.allocation_bps.slice(1).some((bps) => bps !== 0) ||
      vault.route_principal[0].toString() !== "0") {
    throw new Error("Pilot owner, executor, 50% allocation, or zero principal changed");
  }
  const safeUsdc = getAssociatedTokenAddressSync(USDC, SAFE, true);
  const safeShares = getAssociatedTokenAddressSync(SHARES, SAFE, true);
  const [beforeUsdc, beforeShares, signerLamports, fee] = await Promise.all([
    connection.getTokenAccountBalance(safeUsdc, "finalized"),
    connection.getTokenAccountBalance(safeShares, "finalized"),
    connection.getBalance(EXECUTOR, "finalized"),
    connection.getFeeForMessage(message, "finalized"),
  ]);
  if (BigInt(beforeUsdc.value.amount) < 2_000_000n || BigInt(beforeShares.value.amount) !== 0n ||
      fee.value === null || fee.value > FEE_CAP_LAMPORTS || signerLamports < 5_000_000) {
    throw new Error("Pilot balance, empty position, SOL reserve, or fee cap check failed");
  }
  tx.sign([signer]);
  const signature = utils.bytes.bs58.encode(tx.signatures[0]);
  const simulation = await connection.simulateTransaction(tx, { sigVerify: true, commitment: "finalized" });
  console.log(JSON.stringify({ cluster: "solana:mainnet", program: PROGRAM.toBase58(), safe: SAFE.toBase58(),
    signerAndFeePayer: EXECUTOR.toBase58(), action: "kamino_deposit", amountUsdc: "1.000000",
    expectedNetworkFeeSol: fee.value / 1e9, simulatedUnits: simulation.value.unitsConsumed,
    simulationError: simulation.value.err, signature }, null, 2));
  if (simulation.value.err) throw new Error("Signed simulation failed; nothing was sent");
  // Print the signature before send so an ambiguous RPC error can be reconciled without a blind retry.
  const sent = await connection.sendTransaction(tx, { skipPreflight: false, preflightCommitment: "finalized", maxRetries: 0 });
  if (sent !== signature) throw new Error(`RPC returned unexpected signature ${sent}; inspect both before any retry`);
  const confirmation = await connection.confirmTransaction({ signature, ...blockhash }, "finalized");
  if (confirmation.value.err) throw new Error(`Transaction finalized with error: ${JSON.stringify(confirmation.value.err)}`);
  const [afterUsdc, afterShares] = await Promise.all([
    connection.getTokenAccountBalance(safeUsdc, "finalized"),
    connection.getTokenAccountBalance(safeShares, "finalized"),
  ]);
  console.log(JSON.stringify({ signature, finalized: true,
    safeUsdcBeforeRaw: beforeUsdc.value.amount, safeUsdcAfterRaw: afterUsdc.value.amount,
    sharesBeforeRaw: beforeShares.value.amount, sharesAfterRaw: afterShares.value.amount }, null, 2));
  if (BigInt(afterUsdc.value.amount) !== BigInt(beforeUsdc.value.amount) - 1_000_000n ||
      BigInt(afterShares.value.amount) <= 0n) {
    throw new Error("Finalized balance change differed from expected 1 USDC deposit; inspect on-chain state");
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
