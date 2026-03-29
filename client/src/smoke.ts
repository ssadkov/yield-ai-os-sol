/**
 * Smoke: initialize vault (strategy Conservative), optional CPI whitelist via ALLOWED_PROGRAMS,
 * then deposit and withdraw using SPL mint (created automatically or MINT from env).
 */
import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { Program, type Idl, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function loadIdl(): Idl {
  const idlPath = join(__dirname, "..", "..", "target", "idl", "yield_vault.json");
  return JSON.parse(readFileSync(idlPath, "utf-8")) as Idl;
}

/** Comma- or whitespace-separated base58 pubkeys (for `initialize` CPI whitelist). */
function parseAllowedPrograms(): PublicKey[] {
  const raw = process.env.ALLOWED_PROGRAMS?.trim();
  if (!raw) return [];
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  if (parts.length > 16) {
    throw new Error("ALLOWED_PROGRAMS: at most 16 program ids (on-chain limit).");
  }
  return parts.map((s) => new PublicKey(s));
}

async function main() {
  const rpc = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
  const ownerPath = process.env.OWNER_KEYPAIR ?? "./keys/owner.json";
  const agentPath = process.env.AGENT_KEYPAIR ?? "./keys/agent.json";
  const mintEnv = process.env.MINT?.trim();
  const allowedPrograms = parseAllowedPrograms();
  const skipTransfers = process.env.SKIP_DEPOSIT_WITHDRAW === "1";

  const owner = loadKeypair(ownerPath);
  const agent = loadKeypair(agentPath);
  const connection = new Connection(rpc, "confirmed");

  const balance = await connection.getBalance(owner.publicKey);
  if (balance < 0.05 * 1e9) {
    console.warn(
      "Owner SOL balance is low; fund the owner wallet on this cluster before continuing."
    );
  }

  const wallet = new Wallet(owner);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idl = loadIdl();
  const program = new Program(idl, provider);
  const programId = program.programId;

  let mintPk: PublicKey;
  if (mintEnv) {
    mintPk = new PublicKey(mintEnv);
    console.log("Using existing mint:", mintPk.toBase58());
  } else {
    console.log("Creating test SPL mint (6 decimals)…");
    mintPk = await createMint(
      connection,
      owner,
      owner.publicKey,
      null,
      6,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );
    console.log("Mint:", mintPk.toBase58());
  }

  const ownerAta = await getOrCreateAssociatedTokenAccount(
    connection,
    owner,
    mintPk,
    owner.publicKey
  );
  console.log("Owner ATA:", ownerAta.address.toBase58());

  if (!mintEnv) {
    const fundAmount = 10_000_000n;
    await mintTo(connection, owner, mintPk, ownerAta.address, owner, Number(fundAmount));
    console.log("Minted", fundAmount.toString(), "raw units to owner ATA");
  } else {
    const bal = await connection.getTokenAccountBalance(ownerAta.address);
    console.log("Owner token balance (raw):", bal.value.amount);
    if (bal.value.amount === "0") {
      if (skipTransfers) {
        console.warn(
          "Owner ATA has 0 tokens, but SKIP_DEPOSIT_WITHDRAW=1 so we will still run initialize."
        );
      } else {
        throw new Error(
          "OWNER_KEYPAIR ATA has 0 tokens. Fund it (faucet for devnet USDC or mint from authority), then re-run. " +
            "Or set SKIP_DEPOSIT_WITHDRAW=1 to only run initialize."
        );
      }
    }
  }

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.publicKey.toBuffer()],
    programId
  );
  console.log("Vault PDA:", vaultPda.toBase58());

  const strategy = { conservative: {} };

  const vaultAlready = await connection.getAccountInfo(vaultPda);
  if (vaultAlready) {
    console.log("Vault PDA already initialized, skipping initialize.");
  } else {
    console.log(
      "Initializing vault (agent = agent key, strategy Conservative, allowed_programs count:",
      allowedPrograms.length,
      ")…"
    );
    const initSig = await program.methods
      .initialize(agent.publicKey, strategy, allowedPrograms)
      .accounts({
        owner: owner.publicKey,
        usdcMint: mintPk,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("initialize:", initSig);
  }

  const vaultUsdcAta = await getAssociatedTokenAddress(mintPk, vaultPda, true);

  if (skipTransfers) {
    console.log("SKIP_DEPOSIT_WITHDRAW=1, skipping deposit/withdraw.");
    console.log("Vault token ATA:", vaultUsdcAta.toBase58());
    return;
  }

  const depositAmount = new BN(1_000_000);
  console.log("Deposit", depositAmount.toString(), "raw units…");
  const depSig = await program.methods
    .deposit(depositAmount)
    .accounts({
      owner: owner.publicKey,
      usdcMint: mintPk,
      ownerUsdcAta: ownerAta.address,
      vaultUsdcAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log("deposit:", depSig);

  const withdrawAmount = new BN(500_000);
  console.log("Withdraw", withdrawAmount.toString(), "raw units…");
  const wdSig = await program.methods
    .withdraw(withdrawAmount)
    .accounts({
      owner: owner.publicKey,
      usdcMint: mintPk,
      ownerUsdcAta: ownerAta.address,
      vaultUsdcAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log("withdraw:", wdSig);

  const afterOwner = await connection.getTokenAccountBalance(ownerAta.address);
  const afterVault = await connection.getTokenAccountBalance(vaultUsdcAta);
  console.log("Done. Owner ATA raw balance:", afterOwner.value.amount);
  console.log("Vault ATA raw balance:", afterVault.value.amount);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
