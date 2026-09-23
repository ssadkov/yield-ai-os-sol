/** Kamino USDC kVault route against a local validator that clones Kamino from mainnet.
 * Step "prepare" (no validator yet): derives the Safe, asks the Kamino API for deposit/withdraw
 * account lists, and writes the clone list plus a crafted owner USDC account for the validator.
 * Step "run": exercises kamino_deposit / kamino_withdraw through the v2 program.
 * Never run "run" against mainnet: it refuses any RPC that is not localhost.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, type Idl, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCOUNT_SIZE, AccountLayout, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAccount,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";

const here = dirname(fileURLToPath(import.meta.url));
const WORK = process.env.KFORK_DIR ?? "/tmp/kfork";
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const KVAULT_PROGRAM = new PublicKey("KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd");
const USDC_KVAULT = new PublicKey("91b1opzHNUQobfLZxGMNYT5qDRKoqV8FdsdQBmH4wBxy");
const idl = JSON.parse(readFileSync(join(here, "..", "..", "target", "idl", "yield_vault.json"), "utf8")) as Idl;
const PROGRAM_ID = new PublicKey((idl as { address: string }).address);
const OWNER_USDC = BigInt(100_000_000); // 100 USDC

type ApiIx = { programAddress: string; data: string; accounts: { address: string; role: string }[] };

function loadOrCreate(name: string) {
  const path = join(WORK, `${name}.json`);
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  } catch {
    const kp = Keypair.generate();
    writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
    return kp;
  }
}

async function kaminoIxs(action: "deposit" | "withdraw", wallet: PublicKey, amount: string): Promise<ApiIx[]> {
  const res = await fetch(`https://api.kamino.finance/ktx/kvault/${action}-instructions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: wallet.toBase58(), kvault: USDC_KVAULT.toBase58(), amount }),
  });
  if (!res.ok) throw new Error(`Kamino API ${action}: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { instructions: ApiIx[] }).instructions;
}

async function prepare() {
  mkdirSync(WORK, { recursive: true });
  const owner = loadOrCreate("owner");
  loadOrCreate("agent");
  loadOrCreate("attacker");
  const [safe] = PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.publicKey.toBuffer()], PROGRAM_ID);
  const deposit = await kaminoIxs("deposit", safe, "60");
  const withdraw = await kaminoIxs("withdraw", safe, "1");
  writeFileSync(join(WORK, "kamino.json"), JSON.stringify({ deposit, withdraw }, null, 2));

  // Clone every account the kVault instructions touch, except ones that belong to this Safe/test.
  const skip = new Set([safe.toBase58(), TOKEN_PROGRAM_ID.toBase58(), SystemProgram.programId.toBase58(),
    ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
  const programs = new Set<string>([KVAULT_PROGRAM.toBase58()]);
  const accounts = new Set<string>();
  for (const ix of [...deposit, ...withdraw]) {
    if (ix.programAddress === KVAULT_PROGRAM.toBase58()) {
      for (const { address } of ix.accounts) if (!skip.has(address)) accounts.add(address);
    }
  }
  for (const address of [...accounts]) if (address.startsWith("KLend") || address.startsWith("Kvau")) { accounts.delete(address); programs.add(address); }
  const safeAtas = new Set([getAssociatedTokenAddressSync(USDC, safe, true).toBase58()]);
  const clone = [...accounts].filter((a) => !safeAtas.has(a));
  writeFileSync(join(WORK, "clone-programs.txt"), [...programs].join("\n") + "\n");
  writeFileSync(join(WORK, "clone-accounts.txt"), clone.join("\n") + "\n");

  // Owner's USDC ATA holding 100 USDC, injected with --account (USDC's mint authority is Circle).
  const ownerAta = getAssociatedTokenAddressSync(USDC, owner.publicKey);
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode({
    mint: USDC, owner: owner.publicKey, amount: OWNER_USDC, delegateOption: 0, delegate: PublicKey.default,
    state: 1, isNativeOption: 0, isNative: BigInt(0), delegatedAmount: BigInt(0), closeAuthorityOption: 0,
    closeAuthority: PublicKey.default,
  }, data);
  writeFileSync(join(WORK, "owner-usdc.json"), JSON.stringify({
    pubkey: ownerAta.toBase58(),
    account: { lamports: 2_039_280, data: [data.toString("base64"), "base64"], owner: TOKEN_PROGRAM_ID.toBase58(), executable: false, rentEpoch: 0 },
  }));
  console.log(`owner ${owner.publicKey.toBase58()} safe ${safe.toBase58()} ownerUsdcAta ${ownerAta.toBase58()}`);
  console.log(`clone ${programs.size} programs, ${clone.length} accounts`);
}

async function expectFailure(label: string, action: () => Promise<unknown>, expected: RegExp) {
  let failure: unknown;
  try { await action(); } catch (error) { failure = error; }
  assert(failure, `${label}: unexpectedly succeeded`);
  assert.match(String(failure) + JSON.stringify((failure as { logs?: string[] }).logs ?? []), expected, `${label}: wrong failure`);
  console.log(`  ok: ${label} rejected`);
}

async function run() {
  const rpc = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(rpc)) throw new Error("fork test runs only against localhost");
  const connection = new Connection(rpc, "confirmed");
  const owner = loadOrCreate("owner"), agent = loadOrCreate("agent"), attacker = loadOrCreate("attacker");
  for (const kp of [owner, agent, attacker]) {
    await connection.confirmTransaction(await connection.requestAirdrop(kp.publicKey, 2_000_000_000), "confirmed");
  }
  const provider = new anchor.AnchorProvider(connection, new Wallet(agent), { commitment: "confirmed" });
  const program = new Program(idl, provider);
  const methods = program.methods as any;
  const [safe] = PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.publicKey.toBuffer()], PROGRAM_ID);
  const safeUsdc = getAssociatedTokenAddressSync(USDC, safe, true);
  const ownerUsdc = getAssociatedTokenAddressSync(USDC, owner.publicKey);
  const { deposit, withdraw } = JSON.parse(readFileSync(join(WORK, "kamino.json"), "utf8")) as { deposit: ApiIx[]; withdraw: ApiIx[] };
  const kvDeposit = deposit.find((ix) => ix.programAddress === KVAULT_PROGRAM.toBase58())!;
  const kvWithdraw = withdraw.find((ix) => ix.programAddress === KVAULT_PROGRAM.toBase58())!;
  const sharesMint = new PublicKey(kvDeposit.accounts[5].address);
  const safeShares = getAssociatedTokenAddressSync(sharesMint, safe, true);
  assert.equal(kvDeposit.accounts[7].address, safeShares.toBase58(), "API shares ATA is not the Safe's");

  const remaining = (ix: ApiIx, replace: Record<number, PublicKey> = {}) => [
    { pubkey: KVAULT_PROGRAM, isSigner: false, isWritable: false },
    ...ix.accounts.map((a, i) => ({ pubkey: replace[i] ?? new PublicKey(a.address), isSigner: false, isWritable: a.role.includes("WRITABLE") })),
  ];
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

  // Owner: Safe with an agent, Kamino target 60%, 100 USDC.
  await methods.initialize(agent.publicKey, [6_000, 0, 0, 0, 0, 0, 0, 0], [])
    .accounts({ owner: owner.publicKey, vault: safe, usdcMint: USDC, vaultUsdcAta: safeUsdc, tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
    .signers([owner]).rpc();
  await methods.deposit(new BN(OWNER_USDC.toString()))
    .accounts({ owner: owner.publicKey, vault: safe, usdcMint: USDC, ownerUsdcAta: ownerUsdc, vaultUsdcAta: safeUsdc, tokenProgram: TOKEN_PROGRAM_ID })
    .signers([owner]).rpc();
  // Relayer (agent) pays for the Safe's shares ATA; the ATA owner is the Safe PDA.
  await sendAndConfirmTransaction(connection, new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(agent.publicKey, safeShares, safe, sharesMint)), [agent]);
  console.log(`safe ${safe.toBase58()} usdc ${(await getAccount(connection, safeUsdc)).amount}`);

  const agentDeposit = (amount: bigint, replace: Record<number, PublicKey> = {}, signer = agent) => methods.kaminoDeposit(new BN(amount.toString()))
    .accounts({ authority: signer.publicKey, vault: safe }).remainingAccounts(remaining(kvDeposit, replace))
    .preInstructions([cu]).signers([signer]).rpc();

  await expectFailure("deposit above 60% target", () => agentDeposit(BigInt(60_000_001)), /AllocationExceeded/);
  const attackerShares = getAssociatedTokenAddressSync(sharesMint, attacker.publicKey);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(attacker.publicKey, attackerShares, attacker.publicKey, sharesMint)), [attacker]);
  await expectFailure("shares routed to attacker", () => agentDeposit(BigInt(1_000_000), { 7: attackerShares }), /NotSafeTokenAccount/);
  await expectFailure("non-agent caller", () => agentDeposit(BigInt(1_000_000), {}, attacker), /Unauthorized/);

  await agentDeposit(BigInt(60_000_000));
  const shares = (await getAccount(connection, safeShares)).amount;
  const idle = (await getAccount(connection, safeUsdc)).amount;
  console.log(`  deposit 60 USDC -> Safe shares ${shares}, idle USDC ${idle}`);
  assert(shares > BigInt(0));
  assert.equal(idle, BigInt(40_000_000));

  const agentWithdraw = (amount: bigint, replace: Record<number, PublicKey> = {}) => methods.kaminoWithdraw(new BN(amount.toString()), false)
    .accounts({ authority: agent.publicKey, vault: safe }).remainingAccounts(remaining(kvWithdraw, replace))
    .preInstructions([cu]).signers([agent]).rpc();
  const attackerUsdc = getAssociatedTokenAddressSync(USDC, attacker.publicKey);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(attacker.publicKey, attackerUsdc, attacker.publicKey, USDC)), [attacker]);
  await expectFailure("withdraw USDC to attacker", () => agentWithdraw(shares, { 5: attackerUsdc }), /NotSafeTokenAccount/);

  await agentWithdraw(shares);
  const after = (await getAccount(connection, safeUsdc)).amount;
  console.log(`  withdraw all shares -> Safe USDC ${after} (deposited 60_000_000)`);
  assert.equal((await getAccount(connection, safeShares)).amount, BigInt(0));
  // kVault rounds shares in its own favour; one 60 USDC round trip on the fork lost 0.001005 USDC.
  console.log(`  round-trip cost: ${Number(OWNER_USDC - after) / 1e6} USDC`);
  assert(after >= OWNER_USDC - BigInt(10_000), "round trip lost more than 0.01 USDC");

  await methods.withdraw(new BN(after.toString()))
    .accounts({ owner: owner.publicKey, vault: safe, usdcMint: USDC, ownerUsdcAta: ownerUsdc, vaultUsdcAta: safeUsdc, tokenProgram: TOKEN_PROGRAM_ID })
    .signers([owner]).rpc();
  console.log(`PASS: Kamino route on mainnet fork. Owner USDC back: ${(await getAccount(connection, ownerUsdc)).amount}`);
}

const step = process.argv[2];
(step === "prepare" ? prepare() : step === "run" ? run() : Promise.reject(new Error("usage: prepare | run")))
  .catch((error) => { console.error(error); process.exitCode = 1; });
