import bs58 from "bs58";
import BN from "bn.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { convertAll, rebalance, individualSwap, type RebalanceResult } from "./rebalance/engine";
import { buildKaminoKvaultDepositTx, buildKaminoKvaultWithdrawTx } from "./protocols/kaminoKvault";
import {
  buildJupiterBorrowCollateralDepositTx,
  buildJupiterBorrowCollateralWithdrawTx,
  buildJupiterBorrowUsdcBorrowTx,
  buildJupiterBorrowUsdcRepayTx,
  buildJupiterBorrowInitPositionSetupTx,
  findExistingVaultJupiterBorrowPosition,
  JUPITER_REPAY_DUST_PREFIX,
  JUPITER_REPAY_SAFETY_MEDIUM,
} from "./protocols/jupiterBorrow";
import { readVaultAccount } from "./rebalance/portfolio";
import { signAndSendTx } from "./swap/send";
import { deriveVaultPda } from "./swap/anchorIx";

export type RebalanceAction = "rebalance" | "convert_all";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length ? v : undefined;
}

function loadAuthorityKeypairFromEnv(): Keypair {
  const raw = requiredEnv("AUTHORITY_SECRET_KEY").trim();

  // Accept either JSON array "[1,2,...]" or base58 secret key.
  if (raw.startsWith("[")) {
    const arr = JSON.parse(raw) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }

  const bytes = bs58.decode(raw);
  return Keypair.fromSecretKey(bytes);
}

export async function runRebalanceJob(args: {
  ownerPubkey: string;
  action?: RebalanceAction;
}): Promise<RebalanceResult> {
  const apiKey = requiredEnv("JUPITER_API_KEY");
  const rpcUrl = optionalEnv("RPC_URL") ?? optionalEnv("NEXT_PUBLIC_RPC_URL") ?? "";
  if (!rpcUrl) throw new Error("Missing RPC_URL");

  const vaultProgramIdStr =
    optionalEnv("VAULT_PROGRAM_ID") ?? optionalEnv("NEXT_PUBLIC_PROGRAM_ID") ?? "";
  if (!vaultProgramIdStr) throw new Error("Missing VAULT_PROGRAM_ID");

  const slippageBps = Number(optionalEnv("SLIPPAGE_BPS") ?? "300");
  if (!Number.isFinite(slippageBps) || slippageBps <= 0) {
    throw new Error("Invalid SLIPPAGE_BPS");
  }

  const authority = loadAuthorityKeypairFromEnv();
  const vaultProgramId = new PublicKey(vaultProgramIdStr);
  const vaultOwner = new PublicKey(args.ownerPubkey);
  const connection = new Connection(rpcUrl, "confirmed");

  const fn = args.action === "convert_all" ? convertAll : rebalance;
  return fn({
    connection,
    authority,
    vaultProgramId,
    vaultOwner,
    apiKey,
    rpcUrl,
    slippageBps,
  });
}

export async function runIndividualSwapJob(args: {
  ownerPubkey: string;
  inputMint: string;
  outputMint: string;
  amount: string;
  amountUsd: number;
  slippageBps?: number;
}): Promise<RebalanceResult> {
  const apiKey = requiredEnv("JUPITER_API_KEY");
  const rpcUrl = optionalEnv("RPC_URL") ?? optionalEnv("NEXT_PUBLIC_RPC_URL") ?? "";
  if (!rpcUrl) throw new Error("Missing RPC_URL");

  const vaultProgramIdStr =
    optionalEnv("VAULT_PROGRAM_ID") ?? optionalEnv("NEXT_PUBLIC_PROGRAM_ID") ?? "";
  if (!vaultProgramIdStr) throw new Error("Missing VAULT_PROGRAM_ID");

  const authority = loadAuthorityKeypairFromEnv();
  const vaultProgramId = new PublicKey(vaultProgramIdStr);
  const vaultOwner = new PublicKey(args.ownerPubkey);
  const connection = new Connection(rpcUrl, "confirmed");

  const slippageBps = args.slippageBps ?? Number(optionalEnv("SLIPPAGE_BPS") ?? "100");

  return individualSwap({
    connection,
    authority,
    vaultProgramId,
    vaultOwner,
    apiKey,
    rpcUrl,
    inputMint: args.inputMint,
    outputMint: args.outputMint,
    amount: args.amount,
    amountUsd: args.amountUsd,
    slippageBps,
  });
}

export async function runKaminoKvaultDepositJob(args: {
  ownerPubkey: string;
  kvault: string;
  amount: string;
}): Promise<RebalanceResult> {
  return runKaminoKvaultActionJob({ ...args, action: "deposit" });
}

export async function runKaminoKvaultWithdrawJob(args: {
  ownerPubkey: string;
  kvault: string;
  amount: string;
}): Promise<RebalanceResult> {
  return runKaminoKvaultActionJob({ ...args, action: "withdraw" });
}

export async function runJupiterBorrowCollateralDepositJob(args: {
  ownerPubkey: string;
  vaultId: number;
  amountRaw: string;
  positionId?: number;
}): Promise<RebalanceResult> {
  const rpcUrl = optionalEnv("RPC_URL") ?? optionalEnv("NEXT_PUBLIC_RPC_URL") ?? "";
  if (!rpcUrl) throw new Error("Missing RPC_URL");

  const vaultProgramIdStr =
    optionalEnv("VAULT_PROGRAM_ID") ?? optionalEnv("NEXT_PUBLIC_PROGRAM_ID") ?? "";
  if (!vaultProgramIdStr) throw new Error("Missing VAULT_PROGRAM_ID");

  const authority = loadAuthorityKeypairFromEnv();
  const vaultProgramId = new PublicKey(vaultProgramIdStr);
  const vaultOwner = new PublicKey(args.ownerPubkey);
  const vaultPda = deriveVaultPda(vaultProgramId, vaultOwner);
  const connection = new Connection(rpcUrl, "confirmed");

  const vault = await readVaultAccount(connection, vaultPda);

  const whitelistedSet = new Set(vault.allowedPrograms.map((p) => p.toBase58()));
  const jupiterProgram = "jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi";
  const missing = whitelistedSet.has(jupiterProgram) ? [] : [jupiterProgram];
  if (missing.length > 0) {
    return { status: "needs_whitelist", missingPrograms: missing, swaps: [] };
  }

  const signatures: string[] = [];

  let positionId = args.positionId;
  if (!positionId) {
    const existingPosition = await findExistingVaultJupiterBorrowPosition({
      connection,
      vault: vaultPda,
      vaultId: args.vaultId,
    });
    if (existingPosition) {
      positionId = existingPosition.positionId;
    }
  }

  if (!positionId) {
    const authorityLamports = await connection.getBalance(authority.publicKey, "confirmed");
    const minimumSetupLamports = 25_000_000;
    if (authorityLamports < minimumSetupLamports) {
      return {
        status: "error",
        signatures,
        swaps: [],
        error: `Jupiter Lend position setup needs executor SOL for rent/metadata. Executor balance: ${authorityLamports} lamports, recommended minimum: ${minimumSetupLamports} lamports.`,
      };
    }

    const setup = await buildJupiterBorrowInitPositionSetupTx({
      connection,
      authority: authority.publicKey,
      vault: vaultPda,
      vaultId: args.vaultId,
    });
    const setupResult = await signAndSendTx({
      connection,
      authority,
      ixs: setup.tx.ixs,
      alts: [],
    });
    if (setupResult.err) {
      return {
        status: "error",
        signatures,
        swaps: [],
        error: `Jupiter Lend position setup (${setup.tx.label}) failed: ${JSON.stringify(setupResult.err)}. Position id: ${setup.nftId}`,
      };
    }
    if (setupResult.signature) signatures.push(setupResult.signature);
    positionId = setup.nftId;
  }

  const built = await buildJupiterBorrowCollateralDepositTx({
    connection,
    vaultProgramId,
    authority: authority.publicKey,
    vault: vaultPda,
    vaultId: args.vaultId,
    amountRaw: args.amountRaw,
    positionId,
  });

  for (let i = 0; i < built.txs.length; i++) {
    const tx = built.txs[i];
    const result = await signAndSendTx({
      connection,
      authority,
      ixs: tx.ixs,
      alts: built.alts,
    });

    if (result.err) {
      return {
        status: "error",
        signatures,
        swaps: [],
        error: `Jupiter Lend collateral deposit (${tx.label}, step ${i + 1}/${built.txs.length}) failed: ${JSON.stringify(result.err)}. Build summary: ${JSON.stringify(built.summary)}`,
      };
    }
    if (result.signature) signatures.push(result.signature);
  }

  return { status: "success", signatures, swaps: [] };
}

export async function runJupiterBorrowCollateralWithdrawJob(args: {
  ownerPubkey: string;
  vaultId: number;
  positionId?: number;
}): Promise<RebalanceResult> {
  const rpcUrl = optionalEnv("RPC_URL") ?? optionalEnv("NEXT_PUBLIC_RPC_URL") ?? "";
  if (!rpcUrl) throw new Error("Missing RPC_URL");

  const vaultProgramIdStr =
    optionalEnv("VAULT_PROGRAM_ID") ?? optionalEnv("NEXT_PUBLIC_PROGRAM_ID") ?? "";
  if (!vaultProgramIdStr) throw new Error("Missing VAULT_PROGRAM_ID");

  const authority = loadAuthorityKeypairFromEnv();
  const vaultProgramId = new PublicKey(vaultProgramIdStr);
  const vaultOwner = new PublicKey(args.ownerPubkey);
  const vaultPda = deriveVaultPda(vaultProgramId, vaultOwner);
  const connection = new Connection(rpcUrl, "confirmed");

  const vault = await readVaultAccount(connection, vaultPda);
  const whitelistedSet = new Set(vault.allowedPrograms.map((p) => p.toBase58()));
  const jupiterProgram = "jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi";
  const missing = whitelistedSet.has(jupiterProgram) ? [] : [jupiterProgram];
  if (missing.length > 0) {
    return { status: "needs_whitelist", missingPrograms: missing, swaps: [] };
  }

  let positionId = args.positionId;
  if (!positionId) {
    const existingPosition = await findExistingVaultJupiterBorrowPosition({
      connection,
      vault: vaultPda,
      vaultId: args.vaultId,
    });
    positionId = existingPosition?.positionId;
  }
  if (!positionId) {
    return {
      status: "error",
      signatures: [],
      swaps: [],
      error: `No Jupiter Lend position found for vaultId ${args.vaultId}`,
    };
  }

  let built;
  try {
    built = await buildJupiterBorrowCollateralWithdrawTx({
      connection,
      vaultProgramId,
      authority: authority.publicKey,
      vault: vaultPda,
      vaultId: args.vaultId,
      positionId,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Jupiter SDK precheck (e.g. "Ratio … out of bounds") fires before any
    // tx is built. Surface as a clean error instead of a 500 from the
    // route — dust positions are the typical trigger here.
    if (/ratio.*out of bounds/i.test(msg)) {
      return {
        status: "error",
        signatures: [],
        swaps: [],
        error:
          "Jupiter Lend rejected withdraw planning (Ratio out of bounds). This usually means residual debt + dust collateral leave the position in a state it can't auto-unwind. Try a fresh borrow→repay round to clear dust, or unwind manually.",
      };
    }
    if (/manual unwind required|too small to safely partial-withdraw/i.test(msg)) {
      return {
        status: "error",
        signatures: [],
        swaps: [],
        error: msg,
      };
    }
    throw err;
  }

  const signatures: string[] = [];
  for (let i = 0; i < built.txs.length; i++) {
    const tx = built.txs[i];
    const result = await signAndSendTx({
      connection,
      authority,
      ixs: tx.ixs,
      alts: built.alts,
    });

    if (result.err) {
      const errStr = JSON.stringify(result.err);
      // LIBRARY_MATH_ERROR (custom 0x1770 = 6000) on MAX withdraw means
      // residual debt still trips the LTV math (col_final = 0, debt > 0).
      // Surface as a friendly note rather than a wall of logs — partial
      // withdraw is the recommended next step (and the builder already
      // does that when it can read the position).
      if (
        errStr.includes("0x1770") ||
        errStr.includes("LibraryMathError") ||
        errStr.includes("LIBRARY_MATH_ERROR")
      ) {
        return {
          status: "error",
          signatures,
          swaps: [],
          error:
            "Jupiter Lend collateral withdraw failed: position has residual debt that prevents pulling all collateral. Repay the dust first or unwind manually.",
        };
      }
      return {
        status: "error",
        signatures,
        swaps: [],
        error: `Jupiter Lend collateral withdraw (${tx.label}, step ${i + 1}/${built.txs.length}) failed: ${errStr}. Build summary: ${JSON.stringify(built.summary)}`,
      };
    }
    if (result.signature) signatures.push(result.signature);
  }

  return { status: "success", signatures, swaps: [], note: built.note };
}

export async function runJupiterBorrowUsdcBorrowJob(args: {
  ownerPubkey: string;
  vaultId: number;
  amountRaw: string;
  positionId?: number;
}): Promise<RebalanceResult> {
  const rpcUrl = optionalEnv("RPC_URL") ?? optionalEnv("NEXT_PUBLIC_RPC_URL") ?? "";
  if (!rpcUrl) throw new Error("Missing RPC_URL");

  const vaultProgramIdStr =
    optionalEnv("VAULT_PROGRAM_ID") ?? optionalEnv("NEXT_PUBLIC_PROGRAM_ID") ?? "";
  if (!vaultProgramIdStr) throw new Error("Missing VAULT_PROGRAM_ID");

  const authority = loadAuthorityKeypairFromEnv();
  const vaultProgramId = new PublicKey(vaultProgramIdStr);
  const vaultOwner = new PublicKey(args.ownerPubkey);
  const vaultPda = deriveVaultPda(vaultProgramId, vaultOwner);
  const connection = new Connection(rpcUrl, "confirmed");

  const vault = await readVaultAccount(connection, vaultPda);
  const whitelistedSet = new Set(vault.allowedPrograms.map((p) => p.toBase58()));
  const jupiterProgram = "jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi";
  const missing = whitelistedSet.has(jupiterProgram) ? [] : [jupiterProgram];
  if (missing.length > 0) {
    return { status: "needs_whitelist", missingPrograms: missing, swaps: [] };
  }

  let positionId = args.positionId;
  if (!positionId) {
    const existingPosition = await findExistingVaultJupiterBorrowPosition({
      connection,
      vault: vaultPda,
      vaultId: args.vaultId,
    });
    positionId = existingPosition?.positionId;
  }
  if (!positionId) {
    return {
      status: "error",
      signatures: [],
      swaps: [],
      error: `No Jupiter Lend position found for vaultId ${args.vaultId}`,
    };
  }

  const built = await buildJupiterBorrowUsdcBorrowTx({
    connection,
    vaultProgramId,
    authority: authority.publicKey,
    vault: vaultPda,
    vaultId: args.vaultId,
    positionId,
    amountRaw: args.amountRaw,
  });

  const signatures: string[] = [];
  for (let i = 0; i < built.txs.length; i++) {
    const tx = built.txs[i];
    const result = await signAndSendTx({
      connection,
      authority,
      ixs: tx.ixs,
      alts: built.alts,
    });

    if (result.err) {
      return {
        status: "error",
        signatures,
        swaps: [],
        error: `Jupiter Lend USDC borrow (${tx.label}, step ${i + 1}/${built.txs.length}) failed: ${JSON.stringify(result.err)}. Build summary: ${JSON.stringify(built.summary)}`,
      };
    }
    if (result.signature) signatures.push(result.signature);
  }

  return { status: "success", signatures, swaps: [] };
}

export async function runJupiterBorrowUsdcRepayJob(args: {
  ownerPubkey: string;
  vaultId: number;
  amountRaw: string;
  positionId?: number;
  max?: boolean;
}): Promise<RebalanceResult> {
  const rpcUrl = optionalEnv("RPC_URL") ?? optionalEnv("NEXT_PUBLIC_RPC_URL") ?? "";
  if (!rpcUrl) throw new Error("Missing RPC_URL");

  const vaultProgramIdStr =
    optionalEnv("VAULT_PROGRAM_ID") ?? optionalEnv("NEXT_PUBLIC_PROGRAM_ID") ?? "";
  if (!vaultProgramIdStr) throw new Error("Missing VAULT_PROGRAM_ID");

  const authority = loadAuthorityKeypairFromEnv();
  const vaultProgramId = new PublicKey(vaultProgramIdStr);
  const vaultOwner = new PublicKey(args.ownerPubkey);
  const vaultPda = deriveVaultPda(vaultProgramId, vaultOwner);
  const connection = new Connection(rpcUrl, "confirmed");

  const vault = await readVaultAccount(connection, vaultPda);
  const whitelistedSet = new Set(vault.allowedPrograms.map((p) => p.toBase58()));
  const jupiterProgram = "jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi";
  const missing = whitelistedSet.has(jupiterProgram) ? [] : [jupiterProgram];
  if (missing.length > 0) {
    return { status: "needs_whitelist", missingPrograms: missing, swaps: [] };
  }

  let positionId = args.positionId;
  if (!positionId) {
    const existingPosition = await findExistingVaultJupiterBorrowPosition({
      connection,
      vault: vaultPda,
      vaultId: args.vaultId,
    });
    positionId = existingPosition?.positionId;
  }
  if (!positionId) {
    return {
      status: "error",
      signatures: [],
      swaps: [],
      error: `No Jupiter Lend position found for vaultId ${args.vaultId}`,
    };
  }

  type RepayAttempt =
    | { kind: "success"; signatures: string[]; note?: string }
    | { kind: "user_debt_too_low"; signatures: string[]; error: string }
    | { kind: "error"; signatures: string[]; error: string }
    | { kind: "no_debt" }
    | { kind: "dust_skip" };

  const attemptRepay = async (
    safetyOverrideUserRaw?: BN,
  ): Promise<RepayAttempt> => {
    let built;
    try {
      built = await buildJupiterBorrowUsdcRepayTx({
        connection,
        vaultProgramId,
        authority: authority.publicKey,
        vault: vaultPda,
        vaultId: args.vaultId,
        positionId: positionId!,
        amountRaw: args.amountRaw,
        max: args.max,
        safetyOverrideUserRaw,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no outstanding debt/i.test(msg)) return { kind: "no_debt" };
      if (msg.startsWith(JUPITER_REPAY_DUST_PREFIX)) return { kind: "dust_skip" };
      throw err;
    }

    const signatures: string[] = [];
    for (let i = 0; i < built.txs.length; i++) {
      const tx = built.txs[i];
      const result = await signAndSendTx({
        connection,
        authority,
        ixs: tx.ixs,
        alts: built.alts,
      });

      if (result.err) {
        const errStr = JSON.stringify(result.err);
        if (
          args.max &&
          (errStr.includes("0x1789") ||
            errStr.includes("VaultUserDebtTooLow") ||
            errStr.includes("VAULT_USER_DEBT_TOO_LOW"))
        ) {
          return {
            kind: "user_debt_too_low",
            signatures,
            error: `Jupiter Lend USDC repay (${tx.label}, step ${i + 1}/${built.txs.length}) hit VAULT_USER_DEBT_TOO_LOW. Build summary: ${JSON.stringify(built.summary)}`,
          };
        }
        return {
          kind: "error",
          signatures,
          error: `Jupiter Lend USDC repay (${tx.label}, step ${i + 1}/${built.txs.length}) failed: ${errStr}. Build summary: ${JSON.stringify(built.summary)}`,
        };
      }
      if (result.signature) signatures.push(result.signature);
    }
    return { kind: "success", signatures, note: built.note };
  };

  // Aggressive full-close first (decided inside the builder based on size).
  const attempt = await attemptRepay();

  // If our heuristic chose `safety=2` and the chain rejected the residual as
  // below min_user_debt, retry once with the safer 100 user-unit margin.
  // We never know exactly where Jupiter's min_user_debt sits, so this lets
  // the runner self-heal without forcing the user to retry manually.
  if (attempt.kind === "user_debt_too_low" && args.max) {
    const retry = await attemptRepay(JUPITER_REPAY_SAFETY_MEDIUM);
    if (retry.kind === "success") {
      return {
        status: "success",
        signatures: retry.signatures,
        swaps: [],
        note: retry.note
          ? `${retry.note} (retried with medium safety after VAULT_USER_DEBT_TOO_LOW)`
          : "Retried repay with medium safety margin after VAULT_USER_DEBT_TOO_LOW.",
      };
    }
    if (retry.kind === "user_debt_too_low") {
      return {
        status: "success",
        signatures: retry.signatures,
        swaps: [],
        note: "Jupiter Lend rejected partial repay (debt below protocol minimum after both safety attempts). Treating position as effectively closed.",
      };
    }
    if (retry.kind === "dust_skip") {
      return {
        status: "success",
        signatures: [],
        swaps: [],
        note: "Jupiter Lend rejected partial repay (debt below protocol minimum after both safety attempts). Treating position as effectively closed.",
      };
    }
    if (retry.kind === "error") {
      return { status: "error", signatures: retry.signatures, swaps: [], error: retry.error };
    }
    // retry.kind === "no_debt" — fall through to success
    return { status: "success", signatures: [], swaps: [] };
  }

  if (attempt.kind === "success") {
    return { status: "success", signatures: attempt.signatures, swaps: [], note: attempt.note };
  }
  if (attempt.kind === "no_debt") {
    return { status: "success", signatures: [], swaps: [] };
  }
  if (attempt.kind === "dust_skip") {
    return {
      status: "success",
      signatures: [],
      swaps: [],
      note: "Jupiter Lend debt is dust (< $0.10 USDC) — partial repay skipped, treating position as effectively closed.",
    };
  }
  if (attempt.kind === "user_debt_too_low") {
    // Non-max repays that hit this error are a real failure — propagate.
    return { status: "error", signatures: attempt.signatures, swaps: [], error: attempt.error };
  }
  return { status: "error", signatures: attempt.signatures, swaps: [], error: attempt.error };
}

async function runKaminoKvaultActionJob(args: {
  ownerPubkey: string;
  kvault: string;
  amount: string;
  action: "deposit" | "withdraw";
}): Promise<RebalanceResult> {
  const rpcUrl = optionalEnv("RPC_URL") ?? optionalEnv("NEXT_PUBLIC_RPC_URL") ?? "";
  if (!rpcUrl) throw new Error("Missing RPC_URL");

  const vaultProgramIdStr =
    optionalEnv("VAULT_PROGRAM_ID") ?? optionalEnv("NEXT_PUBLIC_PROGRAM_ID") ?? "";
  if (!vaultProgramIdStr) throw new Error("Missing VAULT_PROGRAM_ID");

  const authority = loadAuthorityKeypairFromEnv();
  const vaultProgramId = new PublicKey(vaultProgramIdStr);
  const vaultOwner = new PublicKey(args.ownerPubkey);
  const vaultPda = deriveVaultPda(vaultProgramId, vaultOwner);
  const connection = new Connection(rpcUrl, "confirmed");

  const buildTx = args.action === "deposit" ? buildKaminoKvaultDepositTx : buildKaminoKvaultWithdrawTx;
  const [vault, built] = await Promise.all([
    readVaultAccount(connection, vaultPda),
    buildTx({
      connection,
      vaultProgramId,
      authority: authority.publicKey,
      vault: vaultPda,
      kvault: new PublicKey(args.kvault),
      amount: args.amount,
    }),
  ]);

  const whitelistedSet = new Set(vault.allowedPrograms.map((p) => p.toBase58()));
  const missing = built.requiredPrograms.filter((p) => !whitelistedSet.has(p));
  if (missing.length > 0) {
    return { status: "needs_whitelist", missingPrograms: missing, swaps: [] };
  }

  const signatures: string[] = [];
  for (let i = 0; i < built.txs.length; i++) {
    const tx = built.txs[i];
    const result = await signAndSendTx({
      connection,
      authority,
      ixs: tx.ixs,
      alts: built.alts,
    });

    if (result.err) {
      return {
        status: "error",
        signatures,
        swaps: [],
        error: `Kamino kVault ${args.action} (${tx.label}, step ${i + 1}/${built.txs.length}) failed: ${JSON.stringify(result.err)}. Build summary: ${JSON.stringify(built.summary)}`,
      };
    }
    if (result.signature) signatures.push(result.signature);
  }

  return { status: "success", signatures, swaps: [] };
}

