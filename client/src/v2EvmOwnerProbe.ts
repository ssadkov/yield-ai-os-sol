/** Empty EVM Safe and EIP-712 allocation probe. Never transfers USDC. */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { AnchorProvider, Program, Wallet, type Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import { getAccount, getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

const here = dirname(fileURLToPath(import.meta.url));
const idl = JSON.parse(readFileSync(join(here, "../../target/idl/yield_vault.json"), "utf8")) as Idl;
const programId = new PublicKey("8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5");
const mint = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const owner = Buffer.from("d7bd5acfd8b726ccc99ad8d71983293638185619", "hex");
const signature = Buffer.from("f78c3c552e7cbb4b3a4375add06c1595a85c86e07c88d7512755c3add007639b3f7c5a5b19da773c9eb20ff9076ee1e285748f457e3631e6df60ebc3ea077a281c", "hex");
const allocation = [5_000, ...Array(7).fill(0)] as number[];
const deadline = new BN(2_000_000_000);
const [safe] = PublicKey.findProgramAddressSync([Buffer.from("vault_evm"), owner], programId);
assert.equal(safe.toBase58(), "9hoSB5kdEpF3ECuZwoaEHHYXfadJ7r8VyG9eCiB86uU1");
const ata = getAssociatedTokenAddressSync(mint, safe, true);

function signerFromExistingFile(): Keypair {
  const path = process.env.V2_PAYER_KEYPAIR;
  if (!path) throw new Error("V2_PAYER_KEYPAIR must point to the existing protected Devnet payer");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path.replace(/^~/, homedir()), "utf8"))));
}

async function main() {
  const devnet = process.argv.includes("--send-devnet");
  if (!devnet && !process.argv.includes("--local")) throw new Error("Use --local or --send-devnet");
  if (devnet && process.env.V2_EVM_DEVNET_ACK !== "APPROVED_EMPTY_SAFE_AND_ALLOCATION") {
    throw new Error("Devnet sends require the reviewed transaction-specific acknowledgement");
  }
  const connection = new Connection(devnet ? "https://api.devnet.solana.com" : "http://127.0.0.1:8899", "confirmed");
  const genesis = await connection.getGenesisHash();
  assert.equal(genesis, devnet ? "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" : genesis);
  const payer = devnet ? signerFromExistingFile() : Keypair.generate();
  if (devnet) assert.equal(payer.publicKey.toBase58(), "8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A");
  if (!devnet) {
    const air = await connection.requestAirdrop(payer.publicKey, 1_000_000_000);
    await connection.confirmTransaction(air, "confirmed");
  }
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
  const program = new Program(idl, provider);
  assert(program.programId.equals(programId), "Devnet IDL program ID mismatch");

  const create = program.methods.createEvmSafe([...owner]).accountsStrict({
    payer: payer.publicKey, evmVault: safe, usdcMint: mint, vaultUsdcAta: ata,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  });
  let createSig: string | null = null;
  const before = await connection.getAccountInfo(safe, "confirmed");
  if (!before) {
    const rent = await connection.getMinimumBalanceForRentExemption(705) +
      await connection.getMinimumBalanceForRentExemption(165);
    assert(rent <= 10_000_000, `unexpected account rent: ${rent} lamports`);
    const createIx = await create.instruction();
    const createTx = new Transaction().add(createIx);
    createTx.feePayer = payer.publicKey;
    createTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const fee = await connection.getFeeForMessage(createTx.compileMessage());
    assert(fee.value !== null && fee.value <= 100_000, `unexpected creation fee: ${fee.value}`);
    const createSim = await connection.simulateTransaction(createTx);
    assert.equal(createSim.value.err, null, `create simulation: ${JSON.stringify(createSim.value.err)} ${createSim.value.logs?.join("\n")}`);
    console.log(`create simulation ok: ${createSim.value.unitsConsumed} CU, rent ${rent} lamports, fee ${fee.value} lamports`);
    createSig = await create.rpc();
    console.log(`empty Safe created: ${createSig}`);
  }
  const info = await connection.getAccountInfo(safe, "confirmed");
  assert(info?.owner.equals(programId), "EVM Safe account missing or wrong owner");
  const ataInfo = await getAccount(connection, ata, "confirmed");
  assert(ataInfo.owner.equals(safe) && ataInfo.mint.equals(mint), "canonical USDC ATA mismatch");

  const accounts = program.account as unknown as { evmVault: { fetch(address: PublicKey): Promise<unknown> } };
  const set = () => program.methods.evmSetAllocation(allocation, new BN(1), deadline, [...signature]).accountsStrict({
    payer: payer.publicKey, evmVault: safe,
  });
  const initial = await accounts.evmVault.fetch(safe) as { nonce: BN; allocationBps: number[]; ethAddress: number[] };
  assert.equal(Buffer.from(initial.ethAddress).toString("hex"), owner.toString("hex"));
  let setSig: string | null = null;
  if (initial.nonce.toNumber() === 0) {
    await set().simulate();
    console.log("allocation simulation ok");
    setSig = await set().rpc();
    console.log(`allocation set: ${setSig}`);
  } else {
    assert.equal(initial.nonce.toNumber(), 1, "unexpected nonce");
  }
  const state = await accounts.evmVault.fetch(safe) as { nonce: BN; allocationBps: number[]; ethAddress: number[] };
  assert.equal(state.nonce.toString(), "1");
  assert.deepEqual(state.allocationBps, allocation);
  assert.equal(Buffer.from(state.ethAddress).toString("hex"), owner.toString("hex"));

  let replayRejected = false;
  try { await set().simulate(); } catch { replayRejected = true; }
  assert(replayRejected, "replay must fail in transaction simulation");
  console.log(JSON.stringify({ cluster: devnet ? "devnet" : "localnet", safe: safe.toBase58(), ata: ata.toBase58(),
    createSignature: createSig, allocationSignature: setSig, nonce: state.nonce.toString(), replayRejected }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
