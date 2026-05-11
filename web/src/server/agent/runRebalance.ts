import bs58 from "bs58";
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

  const built = await buildJupiterBorrowCollateralWithdrawTx({
    connection,
    vaultProgramId,
    authority: authority.publicKey,
    vault: vaultPda,
    vaultId: args.vaultId,
    positionId,
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
        error: `Jupiter Lend collateral withdraw (${tx.label}, step ${i + 1}/${built.txs.length}) failed: ${JSON.stringify(result.err)}. Build summary: ${JSON.stringify(built.summary)}`,
      };
    }
    if (result.signature) signatures.push(result.signature);
  }

  return { status: "success", signatures, swaps: [] };
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

  let built;
  try {
    built = await buildJupiterBorrowUsdcRepayTx({
      connection,
      vaultProgramId,
      authority: authority.publicKey,
      vault: vaultPda,
      vaultId: args.vaultId,
      positionId,
      amountRaw: args.amountRaw,
      max: args.max,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // If on-chain debt is already 0 (e.g. a prior repay attempt actually
    // landed before its receipt got back to us), the deactivation flow
    // should sail past this step rather than error out.
    if (/no outstanding debt/i.test(msg)) {
      return { status: "success", signatures: [], swaps: [] };
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
      return {
        status: "error",
        signatures,
        swaps: [],
        error: `Jupiter Lend USDC repay (${tx.label}, step ${i + 1}/${built.txs.length}) failed: ${JSON.stringify(result.err)}. Build summary: ${JSON.stringify(built.summary)}`,
      };
    }
    if (result.signature) signatures.push(result.signature);
  }

  return { status: "success", signatures, swaps: [] };
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

