// End-to-end check of the /v2/safe Kamino builders against a local mainnet fork.
// Needs a solana-test-validator cloning Kamino (see client/src/v2KaminoFork.ts "prepare") and
// /tmp/kfork keys; run from web/: tsx --tsconfig tsconfig.json scripts/kamino-ui-fork.ts
import { readFileSync } from "node:fs";
import { AnchorProvider, Program, type Idl, Wallet } from "@coral-xyz/anchor";
import { address, createNoopSigner, createSolanaRpc } from "@solana/kit";
import { KaminoManager, KaminoVault } from "@kamino-finance/klend-sdk";
import Decimal from "decimal.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, ComputeBudgetProgram,
  TransactionInstruction, type AddressLookupTableAccount } from "@solana/web3.js";
import { GET as kaminoRoute } from "../src/app/api/v2/kamino/route";
import idlJson from "../src/idl/yield_vault.json";
import { USDC_MINT } from "../src/lib/constants";
import {
  ixInitialize, ixSetAllocation, ixDepositUsdc, ixKaminoDeposit, ixKaminoWithdraw, ixWithdraw, readSafe,
  KAMINO_SHARES_MINT, KAMINO_USDC_KVAULT, ROUTE_KAMINO_USDC, loadLookupTables,
  type KaminoAccounts, type KaminoWithdrawalPlan,
} from "../src/lib/safeV2";

const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const key = (name: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`/tmp/kfork/${name}.json`, "utf8"))));
const owner = key("owner"), treasury = Keypair.generate();
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/tmp/yield-v2-admin.json", "utf8"))));

async function send(label: string, signer: Keypair, ixs: TransactionInstruction[], tables: AddressLookupTableAccount[] = []) {
  const { blockhash } = await conn.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs] }).compileToV0Message(tables));
  tx.sign([signer]);
  const simulation = await conn.simulateTransaction(tx);
  if (simulation.value.err) throw new Error(`${label} simulation failed: ${JSON.stringify(simulation.value.err)}\n${simulation.value.logs?.join("\n")}`);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false });
  await conn.confirmTransaction(sig, "confirmed");
  console.log(`  ok ${label} (${tx.serialize().length} bytes)`);
}

function toAccounts(kind: "deposit" | "withdraw", safe: PublicKey): KaminoAccounts {
  const api = JSON.parse(readFileSync("/tmp/kfork/kamino.json", "utf8"))[kind] as { programAddress: string; data: string; accounts: { address: string; role: string }[] }[];
  const ix = api.find((i) => i.programAddress.startsWith("Kvau"))!;
  if (ix.accounts[0].address !== safe.toBase58()) throw new Error("API accounts are for a different Safe");
  return { safe: safe.toBase58(), discriminator: Buffer.from(ix.data, "base64").subarray(0, 8).toString("hex"),
    accounts: ix.accounts.map((a) => ({ address: a.address, writable: a.role.includes("WRITABLE") })), lookupTables: [] };
}

function fromKit(ix: { programAddress: string; data?: Iterable<number>; accounts?: readonly { address: string; role: number }[] }) {
  return new TransactionInstruction({ programId: new PublicKey(ix.programAddress), data: Buffer.from([...(ix.data ?? [])]),
    keys: (ix.accounts ?? []).map((a) => ({ pubkey: new PublicKey(a.address), isWritable: (a.role & 1) !== 0,
      isSigner: (a.role & 2) !== 0 })) });
}

(async () => {
  for (const kp of [owner, admin]) await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 2e9), "confirmed");
  // Protocol config (admin = upgrade authority of the forked program load).
  const prog = new Program(idlJson as Idl, new AnchorProvider(conn, new Wallet(admin), { commitment: "confirmed" }));
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], prog.programId);
  const [programData] = PublicKey.findProgramAddressSync([prog.programId.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"));
  const initConfig = (prog.methods as any).initConfig(treasury.publicKey, 500)
    .accounts({ admin: admin.publicKey, config, programData, systemProgram: SystemProgram.programId });
  await initConfig.simulate();
  await initConfig.rpc();

  await send("create Safe", owner, [await ixInitialize(conn, owner.publicKey)]);
  await send("allocation 60% Kamino", owner, [await ixSetAllocation(conn, owner.publicKey, [6000, 0, 0, 0, 0, 0, 0, 0])]);
  await send("deposit 100 USDC", owner, [await ixDepositUsdc(conn, owner.publicKey, BigInt(100_000_000))]);
  let safe = await readSafe(conn, owner.publicKey);
  const idle = safe.tokens.find((t) => t.isUsdc)!.amount;
  const put = idle * BigInt(6000) / BigInt(10_000);
  await send(`Kamino deposit ${put}`, owner, await ixKaminoDeposit(conn, owner.publicKey, put, toAccounts("deposit", safe.vault)));
  safe = await readSafe(conn, owner.publicKey);
  const shares = safe.tokens.find((t) => t.mint.equals(KAMINO_SHARES_MINT))!.amount;
  console.log(`  Safe: shares ${shares}, principal ${safe.routePrincipal[ROUTE_KAMINO_USDC]}, idle ${safe.tokens.find((t) => t.isUsdc)!.amount}`);
  const rpc = createSolanaRpc("http://127.0.0.1:8899");
  const kvault = new KaminoVault(rpc, address(KAMINO_USDC_KVAULT.toBase58()), 400);
  const vaultState = await kvault.getState();
  const availableBefore = BigInt(vaultState.tokenAvailable.toString());
  const reserves = await new KaminoManager(rpc, 400).loadVaultReserves(vaultState);
  const [reserveAddress, reserve] = [...reserves][0];
  const investIx = await (kvault.client as any).buildInvestSingleReserveIx({
    payer: createNoopSigner(address(owner.publicKey.toBase58())), vault: kvault,
    reserve: { address: reserveAddress, state: reserve.state }, vaultState, vaultReservesMap: reserves,
    tokenProgram: address(TOKEN_PROGRAM_ID.toBase58()),
    payerTokenAta: address(getAssociatedTokenAddressSync(USDC_MINT, owner.publicKey).toBase58()),
    maxAmountLamports: new Decimal(60_000_000),
  });
  const vaultTable = vaultState.vaultLookupTable;
  const investTables = await loadLookupTables(conn, vaultTable === PublicKey.default.toBase58() ? [] : [vaultTable]);
  const skipInvest = process.env.KAMINO_SKIP_INVEST === "1";
  if (!skipInvest) await send("Kamino invest", owner, [fromKit(investIx)], investTables);
  const availableAfter = BigInt((await kvault.reloadState()).tokenAvailable.toString());
  if (!skipInvest && availableAfter >= availableBefore) throw new Error(`invest did not reduce available USDC: ${availableBefore} -> ${availableAfter}`);
  console.log(`  vault available ${availableBefore} -> ${availableAfter}${skipInvest ? " (invest skipped for destination rejection check)" : ""}`);

  const res = await kaminoRoute(new Request(`http://localhost/api/v2/kamino?op=withdraw&owner=${owner.publicKey}&shares=${shares}`));
  const plan = await res.json() as KaminoWithdrawalPlan & { error?: string };
  if (!res.ok) throw new Error(`Kamino withdraw plan: ${plan.error}`);
  if (!skipInvest && !plan.withdrawals.some((leg) => leg.discriminator === "b712469c946da122")) {
    throw new Error("SDK did not select a full reserve withdrawal after invest");
  }
  if (!skipInvest && plan.withdrawals.at(-1)?.shares !== ((BigInt(1) << BigInt(64)) - BigInt(1)).toString()) {
    throw new Error("SDK did not request full redemption on its final reserve leg");
  }
  const withdrawalTables = await loadLookupTables(conn, plan.lookupTables);
  const badLeg = { ...plan.withdrawals[0], accounts: plan.withdrawals[0].accounts.map((account, index) =>
    index === 5 ? { ...account, address: getAssociatedTokenAddressSync(USDC_MINT, owner.publicKey).toBase58() } : account) };
  const badIxs = await ixKaminoWithdraw(conn, owner.publicKey, { ...plan, withdrawals: [badLeg] });
  const badBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const badTx = new VersionedTransaction(new TransactionMessage({ payerKey: owner.publicKey,
    recentBlockhash: badBlockhash, instructions: badIxs }).compileToV0Message(withdrawalTables));
  badTx.sign([owner]);
  const badSimulation = await conn.simulateTransaction(badTx);
  if (!badSimulation.value.err || !badSimulation.value.logs?.some((line) => line.includes("NotSafeTokenAccount"))) {
    throw new Error(`full withdraw accepted a non-Safe USDC destination: ${JSON.stringify(badSimulation.value.err)}`);
  }
  console.log("  ok full withdraw to non-Safe USDC account rejected");
  for (const [index, leg] of plan.withdrawals.entries()) {
    await send(`Kamino withdraw leg ${index + 1}`, owner,
      await ixKaminoWithdraw(conn, owner.publicKey, { ...plan, withdrawals: [leg] }), withdrawalTables);
  }
  safe = await readSafe(conn, owner.publicKey);
  const sharesAfter = safe.tokens.find((t) => t.mint.equals(KAMINO_SHARES_MINT))?.amount ?? BigInt(0);
  console.log(`  Safe after exit: shares ${sharesAfter}, principal ${safe.routePrincipal[ROUTE_KAMINO_USDC]}, USDC ${safe.tokens.find((t) => t.isUsdc)!.amount}`);
  if (sharesAfter !== BigInt(0) || safe.routePrincipal[ROUTE_KAMINO_USDC] !== BigInt(0)) throw new Error("exit incomplete");
  const usdc = safe.tokens.find((token) => token.isUsdc)!;
  await send("full USDC withdrawal to owner", owner, [await ixWithdraw(conn, owner.publicKey, usdc, usdc.amount)]);
  safe = await readSafe(conn, owner.publicKey);
  if (safe.tokens.find((token) => token.isUsdc)?.amount !== BigInt(0)) throw new Error("Safe still holds USDC");
  console.log("PASS: /v2/safe Kamino builders on mainnet fork");
})().catch((e) => { console.error(e); process.exit(1); });
