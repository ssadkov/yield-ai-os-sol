/** Devnet only: create (or reuse) a v2 Safe whose USDC ATA receives CCTP forwarding mints.
 * Owner is a test keypair (V2_OWNER_KEYPAIR), funded from V2_PAYER_KEYPAIR if needed.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, type Idl, Wallet } from "@coral-xyz/anchor";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const V2_DEVNET_PROGRAM_ID = "8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5";
const DEVNET_USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const here = dirname(fileURLToPath(import.meta.url));

function loadOrCreate(path: string) {
  if (!existsSync(path)) writeFileSync(path, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

async function run() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  assert.equal(await connection.getGenesisHash(), DEVNET_GENESIS, "RPC is not Solana Devnet");
  const payer = loadOrCreate(process.env.V2_PAYER_KEYPAIR!);
  const owner = loadOrCreate(process.env.V2_OWNER_KEYPAIR!);
  const provider = new anchor.AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
  const idl = JSON.parse(readFileSync(join(here, "..", "..", "target", "idl", "yield_vault.json"), "utf8")) as Idl;
  const program = new Program(idl, provider);
  assert.equal(program.programId.toBase58(), V2_DEVNET_PROGRAM_ID, "IDL is not the v2 devnet program");

  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.publicKey.toBuffer()], program.programId);
  const vaultAta = getAssociatedTokenAddressSync(DEVNET_USDC, vault, true);
  console.log(`owner ${owner.publicKey.toBase58()}\nsafe  ${vault.toBase58()}\nata   ${vaultAta.toBase58()}`);

  if (!(await connection.getAccountInfo(vault))) {
    if ((await connection.getBalance(owner.publicKey)) < 10_000_000) {
      const fund = new Transaction().add(SystemProgram.transfer({
        fromPubkey: payer.publicKey, toPubkey: owner.publicKey, lamports: 20_000_000 }));
      console.log(`fund tx ${await sendAndConfirmTransaction(connection, fund, [payer])}`);
    }
    // Agent revoked (default key): the CCTP test only needs owner deposit/withdraw.
    const sig = await program.methods.initialize(PublicKey.default, { conservative: {} }, [])
      .accounts({ owner: owner.publicKey, vault, usdcMint: DEVNET_USDC, vaultUsdcAta: vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId })
      .signers([owner]).rpc();
    console.log(`initialize tx ${sig}`);
  } else {
    console.log("safe already exists");
  }
  const ata = await getAccount(connection, vaultAta);
  assert.equal(ata.owner.toBase58(), vault.toBase58());
  assert.equal(ata.mint.toBase58(), DEVNET_USDC.toBase58());
  console.log(`ata owner=safe mint=devnet USDC balance=${Number(ata.amount) / 1e6} USDC`);
  console.log(`mintRecipient bytes32 0x${Buffer.from(vaultAta.toBytes()).toString("hex")}`);
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
