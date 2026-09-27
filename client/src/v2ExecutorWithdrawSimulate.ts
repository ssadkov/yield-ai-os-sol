/** Unsigned simulation of one SDK-planned Kamino withdrawal for the pinned pilot Safe. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import anchor, { type Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

const { AnchorProvider, BorshAccountsCoder, Program } = anchor;
const GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const PROGRAM = new PublicKey("yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih");
const SAFE = new PublicKey("FuDCEZBgp8gxP3gafnHbUJRgGW63VAmtZwsjus1U5qSZ");
const EXECUTOR = new PublicKey("3ayNPp7MoihfbnTQ4q6Ge5PVNe9tJsY5betKqKX7C8aH");
const KAMINO = new PublicKey("KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd");
const KVAULT = "91b1opzHNUQobfLZxGMNYT5qDRKoqV8FdsdQBmH4wBxy";
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SHARES = new PublicKey("B9t9wg8r39Lxm2D9Gmqn2rJ5pVQQwjtGBfSsHAXSEnVe");
const WITHDRAW_FROM_RESERVE = "b712469c946da122";
const WITHDRAW_AVAILABLE = "1383709baadc2239";
type Plan = { safe: string; sourceSharesRaw: string; withdrawals: {
  discriminator: string; shares: string; accounts: { address: string; writable: boolean }[];
}[]; lookupTables: string[] };

export async function buildPilotWithdrawal() {
  const endpoint = process.env.V2_MAINNET_RPC_URL;
  const path = process.env.V2_WITHDRAW_PLAN_FILE;
  if (!endpoint || !path) throw new Error("Set V2_MAINNET_RPC_URL and V2_WITHDRAW_PLAN_FILE");
  const connection = new Connection(endpoint, "finalized");
  if (await connection.getGenesisHash() !== GENESIS) throw new Error("RPC is not Solana Mainnet");
  const plan = JSON.parse(readFileSync(path, "utf8")) as Plan;
  if (plan.safe !== SAFE.toBase58() || plan.withdrawals.length !== 1) throw new Error("Expected one leg for pilot Safe");
  const sharesAta = getAssociatedTokenAddressSync(SHARES, SAFE, true);
  const usdcAta = getAssociatedTokenAddressSync(USDC, SAFE, true);
  const currentShares = await connection.getTokenAccountBalance(sharesAta, "finalized");
  if (currentShares.value.amount !== plan.sourceSharesRaw || currentShares.value.amount === "0") {
    throw new Error("SDK plan does not match current Safe shares");
  }
  const leg = plan.withdrawals[0];
  if (![WITHDRAW_FROM_RESERVE, WITHDRAW_AVAILABLE].includes(leg.discriminator) ||
      leg.accounts[0]?.address !== SAFE.toBase58() || leg.accounts[1]?.address !== KVAULT ||
      leg.accounts[5]?.address !== usdcAta.toBase58() || leg.accounts[7]?.address !== sharesAta.toBase58() ||
      leg.accounts.length < 14 || leg.accounts.length > 40) {
    throw new Error("Unexpected Kamino withdrawal account layout");
  }
  const idl = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../web/src/idl/yield_vault.json"), "utf8")) as Idl;
  if (idl.address !== PROGRAM.toBase58()) throw new Error("Bundled IDL program mismatch");
  const [registry] = PublicKey.findProgramAddressSync([Buffer.from("executor_registry")], PROGRAM);
  const [limits] = PublicKey.findProgramAddressSync([Buffer.from("executor_limits"), SAFE.toBuffer()], PROGRAM);
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM);
  const configInfo = await connection.getAccountInfo(config, "finalized");
  if (!configInfo?.owner.equals(PROGRAM)) throw new Error("Config missing or wrong owner");
  const configState = new BorshAccountsCoder(idl).decode("Config", configInfo.data) as { treasury: PublicKey };
  const treasuryAta = getAssociatedTokenAddressSync(USDC, configState.treasury, true);
  if (!await connection.getAccountInfo(treasuryAta, "finalized")) throw new Error("Treasury USDC ATA missing");
  const wallet = { publicKey: EXECUTOR, signTransaction: async <T,>(tx: T) => tx,
    signAllTransactions: async <T,>(txs: T[]) => txs };
  const program = new Program(idl, new AnchorProvider(connection, wallet as never, { commitment: "finalized" }));
  const ix = await program.methods.kaminoWithdraw(new BN(leg.shares), leg.discriminator === WITHDRAW_FROM_RESERVE)
    .accountsPartial({ authority: EXECUTOR, vault: SAFE, executorRegistry: registry, config,
      treasuryUsdcAta: treasuryAta, tokenProgram: TOKEN_PROGRAM_ID })
    .remainingAccounts([{ pubkey: KAMINO, isSigner: false, isWritable: false },
      ...leg.accounts.map((account) => ({ pubkey: new PublicKey(account.address),
        isSigner: false, isWritable: account.writable })),
      { pubkey: limits, isSigner: false, isWritable: true }]).instruction();
  const tables = await Promise.all(plan.lookupTables.map(async (key) => {
    const value = await connection.getAddressLookupTable(new PublicKey(key), { commitment: "finalized" });
    if (!value.value) throw new Error(`Missing LUT ${key}`);
    return value.value;
  }));
  const blockhash = await connection.getLatestBlockhash("finalized");
  const message = new TransactionMessage({ payerKey: EXECUTOR, recentBlockhash: blockhash.blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 500_000 }), ix] }).compileToV0Message(tables);
  return { connection, message, tx: new VersionedTransaction(message), blockhash,
    sourceSharesRaw: plan.sourceSharesRaw, discriminator: leg.discriminator };
}

async function main() {
  if (process.argv.slice(2).length) throw new Error("No arguments accepted");
  const { connection, message, tx, sourceSharesRaw, discriminator } = await buildPilotWithdrawal();
  const [fee, simulation] = await Promise.all([
    connection.getFeeForMessage(message, "finalized"),
    connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "finalized" }),
  ]);
  console.log(JSON.stringify({ cluster: "solana:mainnet", safe: SAFE.toBase58(),
    signerAndFeePayer: EXECUTOR.toBase58(), action: "kamino_withdraw", sourceSharesRaw, discriminator,
    expectedNetworkFeeSol: fee.value === null ? null : fee.value / 1e9,
    serializedBytes: tx.serialize().length, simulationError: simulation.value.err,
    unitsConsumed: simulation.value.unitsConsumed,
    errorLogs: simulation.value.err ? simulation.value.logs?.filter((line) => /error|failed/i.test(line)).slice(-8) : [],
    sendsTransaction: false }, null, 2));
  if (simulation.value.err) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
