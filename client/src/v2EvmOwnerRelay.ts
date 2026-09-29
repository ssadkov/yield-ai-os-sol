/** Operator relay for a signed EVM-owner Devnet allocation intent. No USDC movement. */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnchorProvider, Program, Wallet, type Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID,
  getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction } from "@solana/web3.js";

const here = dirname(fileURLToPath(import.meta.url));
const idl = JSON.parse(readFileSync(join(here, "../../target/idl/yield_vault.json"), "utf8")) as Idl;
const programId = new PublicKey("8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5");
const mint = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const maxU64 = (1n << 64n) - 1n;

type Intent = {
  owner: string; safe: string; allocationBps: number[];
  nonce: string; deadline: string; signature: string;
};

function parseU64(value: unknown, name: string): bigint {
  assert(typeof value === "string" && /^(0|[1-9]\d{0,19})$/.test(value), `invalid ${name}`);
  const parsed = BigInt(value);
  assert(parsed <= maxU64, `invalid ${name}`);
  return parsed;
}

function readIntent(path: string) {
  const value = JSON.parse(readFileSync(path, "utf8")) as Intent;
  assert(/^0x[\da-fA-F]{40}$/.test(value.owner), "invalid EVM owner");
  assert(/^0x[\da-fA-F]{130}$/.test(value.signature), "invalid signature");
  assert(Array.isArray(value.allocationBps) && value.allocationBps.length === 8
    && value.allocationBps.every((part) => Number.isInteger(part) && part >= 0 && part <= 10_000)
    && value.allocationBps.slice(1).every((part) => part === 0), "invalid Devnet probe allocation");
  const owner = Buffer.from(value.owner.slice(2), "hex");
  assert(owner.some((byte) => byte !== 0), "zero EVM owner");
  const [safe] = PublicKey.findProgramAddressSync([Buffer.from("vault_evm"), owner], programId);
  assert.equal(value.safe, safe.toBase58(), "Safe does not match EVM owner");
  const nonce = parseU64(value.nonce, "nonce");
  const deadline = parseU64(value.deadline, "deadline");
  const now = BigInt(Math.floor(Date.now() / 1000));
  assert(deadline > now && deadline <= now + 900n, "intent expired or deadline too far away");
  return { value, owner, safe, nonce, deadline, signature: Buffer.from(value.signature.slice(2), "hex") };
}

function existingPayer(): Keypair {
  const path = process.env.V2_PAYER_KEYPAIR;
  if (!path) throw new Error("V2_PAYER_KEYPAIR must point to an existing protected Devnet payer");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path.replace(/^~/, homedir()), "utf8"))));
}

async function main() {
  const mode = process.argv[2];
  const path = process.argv[3];
  if ((mode !== "--preflight" && mode !== "--send") || !path) {
    throw new Error("Use --preflight <intent.json> or --send <intent.json>");
  }
  if (mode === "--send" && process.env.V2_EVM_RELAY_ACK !== "APPROVED_DEVNET_EVM_INTENT") {
    throw new Error("Devnet relay send requires transaction-specific acknowledgement");
  }
  assert.equal(idl.address, programId.toBase58(), "Devnet IDL mismatch");
  const { value, owner, safe, nonce, deadline, signature } = readIntent(path);
  const endpoint = process.env.V2_DEVNET_RPC_URL || "https://api.devnet.solana.com";
  assert.equal(new URL(endpoint).protocol, "https:", "Devnet RPC must use HTTPS");
  const connection = new Connection(endpoint, "confirmed");
  assert.equal(await connection.getGenesisHash(), genesis, "RPC is not Solana Devnet");
  const payer = existingPayer();
  const expectedPayer = process.env.V2_EVM_ALLOWED_PAYER || "8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A";
  assert.equal(payer.publicKey.toBase58(), expectedPayer, "payer does not match the configured Devnet sponsor");
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
  const program = new Program(idl, provider);
  const ata = getAssociatedTokenAddressSync(mint, safe, true);

  const accountInfo = await connection.getAccountInfo(safe, "confirmed");
  const instructions = [];
  let rent = 0;
  if (!accountInfo) {
    rent = await connection.getMinimumBalanceForRentExemption(705)
      + await connection.getMinimumBalanceForRentExemption(165);
    assert(rent <= 10_000_000, "Safe creation rent exceeds cap");
    instructions.push(await program.methods.createEvmSafe([...owner]).accountsStrict({
      payer: payer.publicKey, evmVault: safe, usdcMint: mint, vaultUsdcAta: ata,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).instruction());
    assert.equal(nonce, 1n, "new Safe requires nonce 1");
  } else {
    assert(accountInfo.owner.equals(programId), "Safe is not owned by the Devnet program");
    const state = await (program.account as unknown as { evmVault: { fetch(address: PublicKey): Promise<{
      ethAddress: number[]; nonce: BN; allocationBps: number[];
    }> } }).evmVault.fetch(safe);
    assert.equal(Buffer.from(state.ethAddress).toString("hex"), owner.toString("hex"), "Safe owner mismatch");
    if (state.nonce.toString() === nonce.toString()
      && state.allocationBps.every((part, index) => part === value.allocationBps[index])) {
      console.log(JSON.stringify({ status: "already_applied", safe: safe.toBase58(), nonce: value.nonce }));
      return;
    }
    assert.equal(nonce, BigInt(state.nonce.toString()) + 1n, "Safe nonce changed; request a fresh EVM signature");
    const token = await getAccount(connection, ata, "confirmed");
    assert(token.owner.equals(safe) && token.mint.equals(mint), "Safe USDC ATA mismatch");
  }
  instructions.push(await program.methods.evmSetAllocation(
    value.allocationBps, new BN(nonce.toString()), new BN(deadline.toString()), [...signature],
  ).accountsStrict({ payer: payer.publicKey, evmVault: safe }).instruction());

  const tx = new Transaction().add(...instructions);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const fee = await connection.getFeeForMessage(tx.compileMessage());
  assert(fee.value !== null && fee.value <= 100_000, "network fee exceeds cap");
  const simulation = await connection.simulateTransaction(tx);
  assert.equal(simulation.value.err, null, `Devnet simulation failed: ${JSON.stringify(simulation.value.err)} ${simulation.value.logs?.join("\n")}`);
  console.log(JSON.stringify({ status: "simulation_ok", safe: safe.toBase58(),
    owner: value.owner, nonce: value.nonce, allocationBps: value.allocationBps,
    rentLamports: rent, feeLamports: fee.value, computeUnits: simulation.value.unitsConsumed }));
  if (mode === "--preflight") return;

  const txSignature = await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "finalized", skipPreflight: false,
  });
  const after = await (program.account as unknown as { evmVault: { fetch(address: PublicKey): Promise<{
    ethAddress: number[]; nonce: BN; allocationBps: number[];
  }> } }).evmVault.fetch(safe);
  assert.equal(after.nonce.toString(), value.nonce, "post-send nonce mismatch");
  assert(after.allocationBps.every((part, index) => part === value.allocationBps[index]), "post-send allocation mismatch");
  console.log(JSON.stringify({ status: "finalized", safe: safe.toBase58(), txSignature,
    nonce: after.nonce.toString(), allocationBps: after.allocationBps }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
