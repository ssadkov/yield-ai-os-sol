/** Security regression for the first Yield AI v2 contract gate.
 * Local validator by default (airdrops). With V2_CLUSTER=devnet it requires the Solana Devnet genesis,
 * the dedicated v2 program ID and V2_PAYER_KEYPAIR; disposable keys are funded by transfer from that payer
 * and leftover SOL is returned. Never run this against mainnet or a funded user vault.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, type Idl, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createMint,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const V2_DEVNET_PROGRAM_ID = "8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5";
const onDevnet = process.env.V2_CLUSTER === "devnet";
const rpc = onDevnet ? "https://api.devnet.solana.com" : process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
if (!onDevnet && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(rpc)) {
  throw new Error("v2-security runs only against a local validator unless V2_CLUSTER=devnet");
}

const ZERO_ALLOCATION = Array(8).fill(0);
const owner = Keypair.generate();
const agent = Keypair.generate();
const replacementAgent = Keypair.generate();
const attacker = Keypair.generate();
const payer = onDevnet
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(
    (process.env.V2_PAYER_KEYPAIR ?? "").replace(/^~/, homedir()), "utf8"))))
  : Keypair.generate();
const connection = new Connection(rpc, "confirmed");
const provider = new anchor.AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
anchor.setProvider(provider);
const idl = JSON.parse(readFileSync(join(here, "..", "..", "target", "idl", "yield_vault.json"), "utf8")) as Idl;
const program = new Program(idl, provider);

async function expectFailure(label: string, action: () => Promise<unknown>, expected: RegExp) {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  assert(failure, `${label}: transaction unexpectedly succeeded`);
  assert.match(String(failure), expected, `${label}: failed for an unexpected reason`);
}

// The public devnet RPC load-balances nodes; a fresh blockhash is sometimes unknown to the simulating node.
async function sendWithRetry(tx: Transaction, signers: Keypair[]) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
    } catch (error) {
      if (attempt >= 4 || !/Blockhash not found/.test(String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

async function fund(to: PublicKey[], lamports: number) {
  const tx = new Transaction().add(...to.map((toPubkey) =>
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey, lamports })));
  return sendWithRetry(tx, [payer]);
}

async function refund(from: Keypair) {
  const balance = await connection.getBalance(from.publicKey, "confirmed");
  if (balance <= 5_000) return;
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: from.publicKey, toPubkey: payer.publicKey, lamports: balance - 5_000 }));
  await sendWithRetry(tx, [from]);
}

async function run() {
  if (onDevnet) {
    assert.equal(await connection.getGenesisHash(), DEVNET_GENESIS, "RPC is not Solana Devnet");
    assert.equal(program.programId.toBase58(), V2_DEVNET_PROGRAM_ID, "IDL is not the v2 devnet program");
    const before = await connection.getBalance(payer.publicKey, "confirmed");
    console.log(`devnet payer ${payer.publicKey.toBase58()} balance ${before / 1e9} SOL`);
    console.log(`fund tx ${await fund([owner.publicKey], 30_000_000)}`);
  } else {
    const payerAirdrop = await connection.requestAirdrop(payer.publicKey, 3_000_000_000);
    await connection.confirmTransaction(payerAirdrop, "confirmed");
    const airdrop = await connection.requestAirdrop(owner.publicKey, 2_000_000_000);
    await connection.confirmTransaction(airdrop, "confirmed");
  }
  const mint = await createMint(connection, payer, payer.publicKey, null, 6);
  const ownerAta = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, owner.publicKey)).address;
  const attackerAta = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, attacker.publicKey)).address;
  await mintTo(connection, payer, mint, ownerAta, payer, 1_000_000);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.publicKey.toBuffer()], program.programId);
  const vaultAta = getAssociatedTokenAddressSync(mint, vault, true);

  await program.methods.initialize(agent.publicKey, ZERO_ALLOCATION, [TOKEN_PROGRAM_ID])
    .accounts({ owner: owner.publicKey, vault, usdcMint: mint, vaultUsdcAta: vaultAta,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId })
    .signers([owner]).rpc();
  await program.methods.deposit(new BN(1_000_000))
    .accounts({ owner: owner.publicKey, vault, usdcMint: mint, ownerUsdcAta: ownerAta,
      vaultUsdcAta: vaultAta, tokenProgram: TOKEN_PROGRAM_ID })
    .signers([owner]).rpc();

  // Owner allocation targets: enforced sum <= 10_000 bps, owner-only.
  const allocation = [6_000, 3_000, 0, 0, 0, 0, 0, 0];
  await (program.methods as any).setAllocation(allocation).accounts({ owner: owner.publicKey, vault }).signers([owner]).rpc();
  assert.deepEqual((await (program.account as any).vault.fetch(vault)).allocationBps, allocation);
  await expectFailure("allocation above 100%", () => (program.methods as any).setAllocation([6_000, 4_001, 0, 0, 0, 0, 0, 0])
    .accounts({ owner: owner.publicKey, vault }).signers([owner]).rpc(), /AllocationTooHigh/);
  await expectFailure("non-owner set_allocation", () => (program.methods as any).setAllocation(ZERO_ALLOCATION)
    .accounts({ owner: attacker.publicKey, vault }).signers([attacker]).rpc(), /ConstraintSeeds|ConstraintHasOne|AccountNotInitialized/);

  const transfer = createTransferInstruction(vaultAta, attackerAta, vault, 1_000_000);
  const remaining = [
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ...transfer.keys.map((key) => ({ ...key, isSigner: false })),
  ];
  const before = (await getAccount(connection, vaultAta)).amount;
  for (const method of ["executeProtocolCpi", "executeSwapCpi"] as const) {
    await expectFailure(`${method} agent drain`, () => (program.methods as any)[method](Buffer.from(transfer.data))
      .accounts({ authority: agent.publicKey, vault }).remainingAccounts(remaining)
      .signers([agent]).rpc(), /Unauthorized/);
    assert.equal((await getAccount(connection, vaultAta)).amount, before);
    assert.equal((await getAccount(connection, attackerAta)).amount, 0n);
  }

  await expectFailure("non-owner agent rotation", () => (program.methods as any).setAgent(replacementAgent.publicKey)
    .accounts({ owner: attacker.publicKey, vault }).signers([attacker]).rpc(), /ConstraintSeeds|ConstraintHasOne/);
  await (program.methods as any).setAgent(PublicKey.default)
    .accounts({ owner: owner.publicKey, vault }).signers([owner]).rpc();
  assert.equal(((await (program.account as any).vault.fetch(vault)).agent as PublicKey).toBase58(), PublicKey.default.toBase58());
  await (program.methods as any).setAgent(replacementAgent.publicKey)
    .accounts({ owner: owner.publicKey, vault }).signers([owner]).rpc();
  assert.equal(((await (program.account as any).vault.fetch(vault)).agent as PublicKey).toBase58(), replacementAgent.publicKey.toBase58());

  const ownerRecovery = createTransferInstruction(vaultAta, ownerAta, vault, 200_000);
  await program.methods.executeProtocolCpi(Buffer.from(ownerRecovery.data))
    .accounts({ authority: owner.publicKey, vault })
    .remainingAccounts([
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ...ownerRecovery.keys.map((key) => ({ ...key, isSigner: false })),
    ])
    .signers([owner]).rpc();
  assert.equal((await getAccount(connection, vaultAta)).amount, 800_000n);
  assert.equal((await getAccount(connection, ownerAta)).amount, 200_000n);

  // --- Account lifecycle: close_empty_token_account, close_safe + re-initialize, withdraw_excess_lamports.
  const methods = program.methods as any;
  const closeAta = (signer: Keypair) => methods.closeEmptyTokenAccount()
    .accounts({ owner: signer.publicKey, vault, tokenAccount: vaultAta, tokenProgram: TOKEN_PROGRAM_ID })
    .signers([signer]).rpc();
  const closeSafe = (signer: Keypair) => methods.closeSafe()
    .accounts({ owner: signer.publicKey, vault }).signers([signer]).rpc();
  const withdrawExcess = (signer: Keypair) => methods.withdrawExcessLamports()
    .accounts({ owner: signer.publicKey, vault }).signers([signer]).rpc();
  const notOwner = /ConstraintSeeds|ConstraintHasOne|AccountNotInitialized/;

  await expectFailure("close non-empty token account", () => closeAta(owner), /TokenAccountNotEmpty/);
  await expectFailure("non-owner close_safe", () => closeSafe(attacker), notOwner);

  // Close the Safe while its ATA still holds 800_000: the tokens must stay recoverable.
  await closeSafe(owner);
  assert.equal(await connection.getAccountInfo(vault), null, "Safe account still exists after close_safe");
  assert.equal((await getAccount(connection, vaultAta)).amount, 800_000n);
  await program.methods.initialize(agent.publicKey, ZERO_ALLOCATION, [TOKEN_PROGRAM_ID])
    .accounts({ owner: owner.publicKey, vault, usdcMint: mint, vaultUsdcAta: vaultAta,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId })
    .signers([owner]).rpc();

  await program.methods.withdraw(new BN(800_000))
    .accounts({ owner: owner.publicKey, vault, usdcMint: mint, ownerUsdcAta: ownerAta,
      vaultUsdcAta: vaultAta, tokenProgram: TOKEN_PROGRAM_ID })
    .signers([owner]).rpc();
  assert.equal((await getAccount(connection, vaultAta)).amount, 0n);
  assert.equal((await getAccount(connection, ownerAta)).amount, 1_000_000n);

  await expectFailure("non-owner close_empty_token_account", () => closeAta(attacker), notOwner);
  const ataRent = (await connection.getAccountInfo(vaultAta))!.lamports;
  const ownerBeforeClose = await connection.getBalance(owner.publicKey, "confirmed");
  await closeAta(owner);
  assert.equal(await connection.getAccountInfo(vaultAta), null, "vault ATA still exists after close");
  // The provider wallet pays fees, so the owner's balance grows by exactly the ATA rent.
  assert.equal(await connection.getBalance(owner.publicKey, "confirmed"), ownerBeforeClose + ataRent);

  const donation = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vault, lamports: 10_000_000 }));
  await sendWithRetry(donation, [payer]);
  await expectFailure("non-owner withdraw_excess_lamports", () => withdrawExcess(attacker), notOwner);
  await withdrawExcess(owner);
  const vaultInfo = (await connection.getAccountInfo(vault))!;
  assert.equal(vaultInfo.lamports, await connection.getMinimumBalanceForRentExemption(vaultInfo.data.length));
  await expectFailure("withdraw_excess_lamports with nothing to withdraw", () => withdrawExcess(owner), /NoExcessLamports/);

  await closeSafe(owner);
  assert.equal(await connection.getAccountInfo(vault), null, "Safe account still exists after final close_safe");

  // Sponsored creation: payer creates a Safe for an owner holding no SOL; only safe defaults are set.
  const sponsored = Keypair.generate();
  const [sponsoredVault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), sponsored.publicKey.toBuffer()], program.programId);
  const sponsoredAta = getAssociatedTokenAddressSync(mint, sponsoredVault, true);
  const createFor = () => methods.createSafeFor(sponsored.publicKey)
    .accounts({ payer: payer.publicKey, vault: sponsoredVault, usdcMint: mint, vaultUsdcAta: sponsoredAta,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
    .rpc();
  await createFor();
  const created = await (program.account as any).vault.fetch(sponsoredVault);
  assert.equal((created.owner as PublicKey).toBase58(), sponsored.publicKey.toBase58());
  assert.equal((created.agent as PublicKey).toBase58(), PublicKey.default.toBase58());
  assert.deepEqual(created.allocationBps, ZERO_ALLOCATION);
  assert.equal(created.allowedPrograms.length, 0);
  await expectFailure("create_safe_for twice", createFor, /already in use|0x0/);
  const sponsoredRent = (await connection.getAccountInfo(sponsoredVault))!.lamports + (await connection.getAccountInfo(sponsoredAta))!.lamports;
  await methods.closeEmptyTokenAccount()
    .accounts({ owner: sponsored.publicKey, vault: sponsoredVault, tokenAccount: sponsoredAta, tokenProgram: TOKEN_PROGRAM_ID })
    .signers([sponsored]).rpc();
  await methods.closeSafe().accounts({ owner: sponsored.publicKey, vault: sponsoredVault }).signers([sponsored]).rpc();
  // All rent of a sponsored Safe goes to its owner, not to the sponsor.
  assert.equal(await connection.getBalance(sponsored.publicKey, "confirmed"), sponsoredRent);

  console.log(`owner ${owner.publicKey.toBase58()} vault ${vault.toBase58()} mint ${mint.toBase58()}`);
  if (onDevnet) {
    await refund(owner);
    await refund(sponsored);
    console.log(`devnet payer balance after ${(await connection.getBalance(payer.publicKey, "confirmed")) / 1e9} SOL`);
  }
  console.log("PASS: agent CPI drains rejected; owner rotation, CPI recovery, close/re-init recovery, " +
    "empty-ATA close, excess-lamport withdrawal, final close_safe, owner allocation and sponsored create_safe_for succeeded");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
