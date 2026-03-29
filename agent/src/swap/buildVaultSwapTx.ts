import { jupiterFetch } from "../jupiter.ts";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { altsFromJupiter } from "./alts.ts";
import { encodeExecuteSwapCpiData } from "./anchorIx.ts";
import type { ApiInstruction, JupiterBuildResponse } from "./types.ts";

const JUPITER_SWAP_V2_BASE = "/swap/v2";
const COMPUTE_UNIT_LIMIT_MAX = 1_400_000;

function assertMainnetRpcForJupiterBuild(rpcUrl: string): void {
  const u = rpcUrl.toLowerCase();
  if (
    u.includes("devnet") ||
    u.includes("testnet") ||
    u.includes("localhost") ||
    u.includes("127.0.0.1")
  ) {
    throw new Error(
      "Jupiter GET /swap/v2/build returns routes and address lookup tables for mainnet-beta. " +
        "Use a mainnet-beta RPC in RPC_URL (not devnet/testnet/localnet)"
    );
  }
}

async function assertLookupTablesExist(
  connection: Connection,
  raw: Record<string, string[]> | null
): Promise<void> {
  if (!raw) return;
  for (const key of Object.keys(raw)) {
    const pk = new PublicKey(key);
    const info = await connection.getAccountInfo(pk, "confirmed");
    if (!info) {
      throw new Error(
        `Address lookup table ${key} not found on this RPC cluster. ` +
          "Jupiter /build embeds mainnet ALT keys; simulate/send against mainnet-beta with RPC_URL=…"
      );
    }
  }
}

function toAccountMeta(acc: ApiInstruction["accounts"][number]) {
  return {
    pubkey: new PublicKey(acc.pubkey),
    isSigner: acc.isSigner,
    isWritable: acc.isWritable,
  };
}

function toWeb3Instruction(ix: ApiInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map(toAccountMeta),
    data: Buffer.from(ix.data, "base64"),
  });
}

function wrapAsExecuteSwapCpiIx(args: {
  vaultProgramId: PublicKey;
  authority: PublicKey;
  vault: PublicKey;
  inner: ApiInstruction;
}): TransactionInstruction {
  const innerProgramId = new PublicKey(args.inner.programId);
  const innerData = Buffer.from(args.inner.data, "base64");
  const data = encodeExecuteSwapCpiData(innerData);

  const innerKeys = args.inner.accounts.map((a) => {
    const pubkey = new PublicKey(a.pubkey);
    // Jupiter marks taker (vault PDA) as signer; the vault cannot sign the v0 tx.
    // `yield_vault` signs the PDA via `invoke_signed` during CPI.
    const isVaultPda = pubkey.equals(args.vault);
    return {
      pubkey,
      isSigner: isVaultPda ? false : a.isSigner,
      isWritable: a.isWritable,
    };
  });

  return new TransactionInstruction({
    programId: args.vaultProgramId,
    keys: [
      { pubkey: args.authority, isSigner: true, isWritable: true },
      { pubkey: args.vault, isSigner: false, isWritable: true },
      { pubkey: innerProgramId, isSigner: false, isWritable: false },
      ...innerKeys,
    ],
    data,
  });
}

export type BuildVaultSwapParams = {
  apiKey: string;
  rpcUrl: string;
  vaultProgramId: string;
  authorityPubkey: string;
  vaultPubkey: string;
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
};

export type BuiltVaultSwap = {
  build: JupiterBuildResponse;
  whitelistedProgramIds: string[];
  simulateUnsigned?: {
    unitsConsumed: number | null;
    err: unknown;
    logs: string[] | null;
  };
  ixs: TransactionInstruction[];
  alts: ReturnType<typeof altsFromJupiter>;
  estimatedCuLimit: number;
};

export async function buildVaultSwapTx(params: BuildVaultSwapParams): Promise<BuiltVaultSwap> {
  assertMainnetRpcForJupiterBuild(params.rpcUrl);

  const vaultProgramId = new PublicKey(params.vaultProgramId);
  const authority = new PublicKey(params.authorityPubkey);
  const vault = new PublicKey(params.vaultPubkey);

  const qs = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    taker: vault.toBase58(),
    payer: authority.toBase58(),
    slippageBps: String(params.slippageBps),
  });

  const build = await jupiterFetch<JupiterBuildResponse>(
    params.apiKey,
    `${JUPITER_SWAP_V2_BASE}/build?${qs.toString()}`,
    { method: "GET" }
  );

  const uniquePrograms = new Set<string>();
  for (const ix of build.setupInstructions) uniquePrograms.add(ix.programId);
  uniquePrograms.add(build.swapInstruction.programId);
  if (build.cleanupInstruction) uniquePrograms.add(build.cleanupInstruction.programId);
  for (const ix of build.otherInstructions) uniquePrograms.add(ix.programId);

  const whitelistedProgramIds = Array.from(uniquePrograms);

  const wrappedSwapIxs: TransactionInstruction[] = [
    ...build.setupInstructions.map((ix) =>
      wrapAsExecuteSwapCpiIx({ vaultProgramId, authority, vault, inner: ix })
    ),
    wrapAsExecuteSwapCpiIx({ vaultProgramId, authority, vault, inner: build.swapInstruction }),
    ...(build.cleanupInstruction
      ? [
          wrapAsExecuteSwapCpiIx({
            vaultProgramId,
            authority,
            vault,
            inner: build.cleanupInstruction,
          }),
        ]
      : []),
    ...build.otherInstructions.map((ix) =>
      wrapAsExecuteSwapCpiIx({ vaultProgramId, authority, vault, inner: ix })
    ),
  ];

  const computeBudgetIxs = build.computeBudgetInstructions.map(toWeb3Instruction);

  const recentBlockhash = bs58.encode(Buffer.from(build.blockhashWithMetadata.blockhash));
  const lastValidBlockHeight = build.blockhashWithMetadata.lastValidBlockHeight;
  const alts = altsFromJupiter(build.addressesByLookupTableAddress);

  const connection = new Connection(params.rpcUrl, "confirmed");
  await assertLookupTablesExist(connection, build.addressesByLookupTableAddress);

  // Simulate to estimate CU usage (use max first)
  const simulationMessage = new TransactionMessage({
    payerKey: authority,
    recentBlockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT_MAX }),
      ...computeBudgetIxs,
      ...wrappedSwapIxs,
    ],
  }).compileToV0Message(alts);

  const simulationTx = new VersionedTransaction(simulationMessage);
  const simulationResult = await connection.simulateTransaction(simulationTx, {
    replaceRecentBlockhash: true,
  });

  const unitsConsumed = simulationResult.value.unitsConsumed ?? null;
  const estimatedCuLimit =
    unitsConsumed === null
      ? COMPUTE_UNIT_LIMIT_MAX
      : Math.min(Math.ceil(unitsConsumed * 1.2), COMPUTE_UNIT_LIMIT_MAX);

  return {
    build,
    whitelistedProgramIds,
    simulateUnsigned: {
      unitsConsumed,
      err: simulationResult.value.err,
      logs: simulationResult.value.logs ?? null,
    },
    ixs: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: estimatedCuLimit }),
      ...computeBudgetIxs,
      ...wrappedSwapIxs,
    ],
    alts,
    estimatedCuLimit,
  };
}

