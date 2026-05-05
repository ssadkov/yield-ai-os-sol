import { jupiterFetch } from "../jupiter";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { altsFromJupiter } from "./alts";
import type { ApiInstruction, JupiterBuildResponse } from "./types";
import { wrapProtocolCpiIx } from "../protocols/wrapCpi";

const JUPITER_SWAP_V2_BASE = "/swap/v2";
const COMPUTE_UNIT_LIMIT_MAX = 1_400_000;
const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";

function assertMainnetRpcForJupiterBuild(rpcUrl: string): void {
  const u = rpcUrl.toLowerCase();
  if (u.includes("devnet") || u.includes("testnet") || u.includes("localhost") || u.includes("127.0.0.1")) {
    throw new Error(
      "Jupiter GET /swap/v2/build returns routes and address lookup tables for mainnet-beta. " +
        "Use a mainnet-beta RPC in RPC_URL (not devnet/testnet/localnet)",
    );
  }
}

async function assertLookupTablesExist(
  connection: Connection,
  raw: Record<string, string[]> | null,
): Promise<void> {
  if (!raw) return;
  for (const key of Object.keys(raw)) {
    const pk = new PublicKey(key);
    const info = await connection.getAccountInfo(pk, "confirmed");
    if (!info) {
      throw new Error(
        `Address lookup table ${key} not found on this RPC cluster. ` +
          "Jupiter /build embeds mainnet ALT keys; simulate/send against mainnet-beta with RPC_URL=…",
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
  return wrapProtocolCpiIx({
    vaultProgramId: args.vaultProgramId,
    authority: args.authority,
    vault: args.vault,
    inner: {
      programId: args.inner.programId,
      keys: args.inner.accounts,
      data: args.inner.data,
    },
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
  txs: {
    label: "setup" | "swap" | "cleanup_other";
    ixs: TransactionInstruction[];
  }[];
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
    { method: "GET" },
  );

  const uniquePrograms = new Set<string>();
  for (const ix of build.setupInstructions) uniquePrograms.add(ix.programId);
  uniquePrograms.add(build.swapInstruction.programId);
  if (build.cleanupInstruction) uniquePrograms.add(build.cleanupInstruction.programId);
  for (const ix of build.otherInstructions) uniquePrograms.add(ix.programId);
  const whitelistedProgramIds = Array.from(uniquePrograms);

  const wrappedSetupIxs = build.setupInstructions.map((ix) =>
    wrapAsExecuteSwapCpiIx({ vaultProgramId, authority, vault, inner: ix }),
  );
  const wrappedSwapIx = wrapAsExecuteSwapCpiIx({
    vaultProgramId,
    authority,
    vault,
    inner: build.swapInstruction,
  });
  const wrappedCleanupIxs = build.cleanupInstruction
    ? [
        wrapAsExecuteSwapCpiIx({
          vaultProgramId,
          authority,
          vault,
          inner: build.cleanupInstruction,
        }),
      ]
    : [];
  const wrappedOtherIxs = build.otherInstructions.map((ix) =>
    wrapAsExecuteSwapCpiIx({ vaultProgramId, authority, vault, inner: ix }),
  );

  // Jupiter may include its own ComputeBudgetProgram.setComputeUnitLimit which can
  // override our limit if it appears later in the transaction. Keep Jupiter's
  // compute budget instructions except setComputeUnitLimit, and always apply our
  // final CU limit as the last compute-budget instruction.
  const computeBudgetIxs = build.computeBudgetInstructions
    .filter((ix) => {
      if (ix.programId !== COMPUTE_BUDGET_PROGRAM_ID) return true;
      const data = Buffer.from(ix.data, "base64");
      // ComputeBudgetProgram instruction enum:
      // 2 = SetComputeUnitLimit
      return data.length === 0 ? true : data[0] !== 2;
    })
    .map(toWeb3Instruction);

  const recentBlockhash = bs58.encode(Buffer.from(build.blockhashWithMetadata.blockhash));
  const alts = altsFromJupiter(build.addressesByLookupTableAddress);

  const connection = new Connection(params.rpcUrl, "confirmed");
  await assertLookupTablesExist(connection, build.addressesByLookupTableAddress);

  // The wrapped Jupiter CPI can exceed the v0 tx size limit if we try to
  // include setup + swap + cleanup + other in a single transaction. Split into
  // multiple txs and estimate CU using only the swap tx (the most expensive).
  let unitsConsumed: number | null = null;
  let simulateErr: unknown = null;
  let simulateLogs: string[] | null = null;
  let estimatedCuLimit = COMPUTE_UNIT_LIMIT_MAX;
  try {
    const simulationMessage = new TransactionMessage({
      payerKey: authority,
      recentBlockhash,
      instructions: [
        ...computeBudgetIxs,
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT_MAX }),
        wrappedSwapIx,
      ],
    }).compileToV0Message(alts);

    const simulationTx = new VersionedTransaction(simulationMessage);
    const simulationResult = await connection.simulateTransaction(simulationTx, {
      replaceRecentBlockhash: true,
    });

    unitsConsumed = simulationResult.value.unitsConsumed ?? null;
    simulateErr = simulationResult.value.err;
    simulateLogs = simulationResult.value.logs ?? null;
    estimatedCuLimit =
      unitsConsumed === null
        ? COMPUTE_UNIT_LIMIT_MAX
        : Math.min(
            Math.max(Math.ceil(unitsConsumed * 1.4), 400_000),
            COMPUTE_UNIT_LIMIT_MAX,
          );
  } catch (e: unknown) {
    simulateErr = e;
  }

  return {
    build,
    whitelistedProgramIds,
    simulateUnsigned: {
      unitsConsumed,
      err: simulateErr,
      logs: simulateLogs,
    },
    txs: (() => {
      const txs: BuiltVaultSwap["txs"] = [];

      if (wrappedSetupIxs.length > 0) {
        txs.push({
          label: "setup",
          ixs: [
            ...computeBudgetIxs,
            ComputeBudgetProgram.setComputeUnitLimit({ units: estimatedCuLimit }),
            ...wrappedSetupIxs,
          ],
        });
      }

      txs.push({
        label: "swap",
        ixs: [
          ...computeBudgetIxs,
          ComputeBudgetProgram.setComputeUnitLimit({ units: estimatedCuLimit }),
          wrappedSwapIx,
        ],
      });

      if (wrappedCleanupIxs.length > 0 || wrappedOtherIxs.length > 0) {
        txs.push({
          label: "cleanup_other",
          ixs: [
            ...computeBudgetIxs,
            ComputeBudgetProgram.setComputeUnitLimit({ units: estimatedCuLimit }),
            ...wrappedCleanupIxs,
            ...wrappedOtherIxs,
          ],
        });
      }

      return txs;
    })(),
    alts,
    estimatedCuLimit,
  };
}

