/** Unsigned one-USDC executor deposit simulation for the pinned Mainnet pilot Safe. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import anchor, { type Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  ComputeBudgetProgram, Connection, PublicKey, TransactionMessage, VersionedTransaction,
  type AddressLookupTableAccount,
} from "@solana/web3.js";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const PROGRAM = new PublicKey("yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih");
const KAMINO = new PublicKey("KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd");
const KVAULT = "91b1opzHNUQobfLZxGMNYT5qDRKoqV8FdsdQBmH4wBxy";
const SAFE = "FuDCEZBgp8gxP3gafnHbUJRgGW63VAmtZwsjus1U5qSZ";
const EXECUTOR = new PublicKey("3ayNPp7MoihfbnTQ4q6Ge5PVNe9tJsY5betKqKX7C8aH");
const AMOUNT_RAW = 1_000_000;
const CU_LIMIT = 300_000;
const CU_PRICE = 500_000; // 0.5 lamport per requested CU, maximum priority fee 0.00015 SOL.

type ApiIx = { programAddress: string; data: string; accounts: { address: string; role: string }[] };
const { AnchorProvider, Program } = anchor;

export async function buildPilotDeposit() {
  const endpoint = process.env.V2_MAINNET_RPC_URL;
  if (!endpoint) throw new Error("Set V2_MAINNET_RPC_URL to a private Mainnet RPC endpoint");
  const connection = new Connection(endpoint, "finalized");
  if (await connection.getGenesisHash() !== MAINNET_GENESIS) throw new Error("RPC is not Solana Mainnet");
  const [registry] = PublicKey.findProgramAddressSync([Buffer.from("executor_registry")], PROGRAM);
  const [limits] = PublicKey.findProgramAddressSync([Buffer.from("executor_limits"), new PublicKey(SAFE).toBuffer()], PROGRAM);
  const idl = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../web/src/idl/yield_vault.json"), "utf8")) as Idl;
  if (idl.address !== PROGRAM.toBase58()) throw new Error("Bundled IDL program mismatch");

  const response = await fetch("https://api.kamino.finance/ktx/kvault/deposit-instructions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: SAFE, kvault: KVAULT, amount: "1" }),
  });
  if (!response.ok) throw new Error(`Kamino instructions HTTP ${response.status}`);
  const payload = await response.json() as { instructions: ApiIx[]; lutsByAddress?: Record<string, string[]> };
  const quoted = payload.instructions.find((ix) => ix.programAddress === KAMINO.toBase58());
  if (!quoted || quoted.accounts[0]?.address !== SAFE || quoted.accounts[1]?.address !== KVAULT ||
      quoted.accounts.length < 15 || quoted.accounts.length > 25) {
    throw new Error("Unexpected Kamino deposit layout");
  }
  const tables: AddressLookupTableAccount[] = [];
  for (const address of Object.keys(payload.lutsByAddress ?? {})) {
    const result = await connection.getAddressLookupTable(new PublicKey(address), { commitment: "finalized" });
    if (!result.value) throw new Error(`Missing Kamino lookup table: ${address}`);
    tables.push(result.value);
  }

  const wallet = { publicKey: EXECUTOR, signTransaction: async <T,>(tx: T) => tx,
    signAllTransactions: async <T,>(txs: T[]) => txs };
  const program = new Program(idl, new AnchorProvider(connection, wallet as never, { commitment: "finalized" }));
  const ix = await program.methods.kaminoDeposit(new BN(AMOUNT_RAW))
    .accountsPartial({ authority: EXECUTOR, vault: new PublicKey(SAFE), executorRegistry: registry })
    .remainingAccounts([
      { pubkey: KAMINO, isSigner: false, isWritable: false },
      ...quoted.accounts.map((account) => ({ pubkey: new PublicKey(account.address),
        isSigner: false, isWritable: account.role.includes("WRITABLE") })),
      { pubkey: limits, isSigner: false, isWritable: true },
    ]).instruction();
  const blockhash = await connection.getLatestBlockhash("finalized");
  const message = new TransactionMessage({
    payerKey: EXECUTOR, recentBlockhash: blockhash.blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE }), ix],
  }).compileToV0Message(tables);
  const tx = new VersionedTransaction(message); // Signatures remain empty until an explicitly authorized send.
  return { connection, message, tx, blockhash };
}

async function main() {
  if (process.argv.slice(2).length) throw new Error("No arguments accepted: simulation is pinned to 1 USDC and one Safe");
  const { connection, message, tx } = await buildPilotDeposit();
  const [fee, result] = await Promise.all([
    connection.getFeeForMessage(message, "finalized"),
    connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "finalized" }),
  ]);
  console.log(JSON.stringify({
    cluster: "solana:mainnet", safe: SAFE, signerAndFeePayer: EXECUTOR.toBase58(),
    action: "kamino_deposit", amountUsdc: "1.000000", serializedBytes: tx.serialize().length,
    computeUnitLimit: CU_LIMIT, computeUnitPriceMicroLamports: CU_PRICE,
    expectedNetworkFeeSol: fee.value === null ? null : fee.value / 1e9,
    simulationError: result.value.err, unitsConsumed: result.value.unitsConsumed,
    errorLogs: result.value.err ? result.value.logs?.filter((line) => /error|failed/i.test(line)).slice(-8) : [],
    sendsTransaction: false,
  }, null, 2));
  if (result.value.err) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
