import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { takeSnapshot, type PortfolioSnapshot } from "./portfolio.ts";
import { USDC, type TokenDef } from "./tokens.ts";
import { buildVaultSwapTx, type BuiltVaultSwap } from "../swap/buildVaultSwapTx.ts";
import { signAndSendTx } from "../swap/send.ts";
import { deriveVaultPda } from "../swap/anchorIx.ts";

const MIN_SWAP_USD = 0.10;
const DEFAULT_SLIPPAGE_BPS = 100;

export interface SwapAction {
  from: TokenDef;
  to: TokenDef;
  rawAmount: string;
  amountUsd: number;
}

export interface RebalanceResult {
  status: "success" | "needs_whitelist" | "no_rebalance_needed" | "error";
  signatures?: string[];
  missingPrograms?: string[];
  swaps?: SwapAction[];
  error?: string;
}

function computeSwaps(snapshot: PortfolioSnapshot): SwapAction[] {
  const { balances, prices, totalValueUsd, allocations } = snapshot;

  if (totalValueUsd < MIN_SWAP_USD) return [];

  const balanceByMint = new Map(balances.map((b) => [b.token.mint, b]));

  const sells: SwapAction[] = [];
  const buys: SwapAction[] = [];

  for (const alloc of allocations) {
    if (alloc.token.mint === USDC.mint) continue;

    const balance = balanceByMint.get(alloc.token.mint);
    const uiAmount = balance?.uiAmount ?? 0;
    const price = prices.get(alloc.token.mint) ?? 0;
    if (price === 0) continue;

    const currentUsd = uiAmount * price;
    const targetUsd = alloc.weight * totalValueUsd;
    const deltaUsd = targetUsd - currentUsd;

    if (Math.abs(deltaUsd) < MIN_SWAP_USD) continue;

    if (deltaUsd < 0) {
      const sellUiAmount = Math.abs(deltaUsd) / price;
      const rawAmount = Math.floor(sellUiAmount * 10 ** alloc.token.decimals);
      sells.push({
        from: alloc.token,
        to: USDC,
        rawAmount: String(rawAmount),
        amountUsd: Math.abs(deltaUsd),
      });
    } else {
      const usdcPrice = prices.get(USDC.mint) ?? 1;
      const buyUsdcAmount = deltaUsd / usdcPrice;
      const rawAmount = Math.floor(buyUsdcAmount * 10 ** USDC.decimals);
      buys.push({
        from: USDC,
        to: alloc.token,
        rawAmount: String(rawAmount),
        amountUsd: deltaUsd,
      });
    }
  }

  return [...sells, ...buys];
}

export async function rebalance(args: {
  connection: Connection;
  authority: Keypair;
  vaultProgramId: PublicKey;
  vaultOwner: PublicKey;
  apiKey: string;
  rpcUrl: string;
  slippageBps?: number;
}): Promise<RebalanceResult> {
  const {
    connection,
    authority,
    vaultProgramId,
    vaultOwner,
    apiKey,
    rpcUrl,
    slippageBps = DEFAULT_SLIPPAGE_BPS,
  } = args;

  const vaultPda = deriveVaultPda(vaultProgramId, vaultOwner);

  const snapshot = await takeSnapshot({ connection, vaultPda, apiKey });
  const swaps = computeSwaps(snapshot);

  if (swaps.length === 0) {
    return { status: "no_rebalance_needed", swaps: [] };
  }

  // Build ALL swaps once — reuse for whitelist check AND execution
  const builds: BuiltVaultSwap[] = [];
  const allNeededPrograms = new Set<string>();

  for (const swap of swaps) {
    console.log(
      `[rebalance] Building swap: ${swap.rawAmount} ${swap.from.symbol} → ${swap.to.symbol} (~$${swap.amountUsd.toFixed(2)})`,
    );

    const built = await buildVaultSwapTx({
      apiKey,
      rpcUrl,
      vaultProgramId: vaultProgramId.toBase58(),
      authorityPubkey: authority.publicKey.toBase58(),
      vaultPubkey: vaultPda.toBase58(),
      inputMint: swap.from.mint,
      outputMint: swap.to.mint,
      amount: swap.rawAmount,
      slippageBps,
    });

    builds.push(built);
    for (const pid of built.whitelistedProgramIds) {
      allNeededPrograms.add(pid);
    }
  }

  // Check whitelist against the exact programs from these builds
  const whitelistedSet = new Set(
    snapshot.vault.allowedPrograms.map((p) => p.toBase58()),
  );
  const missing = [...allNeededPrograms].filter((p) => !whitelistedSet.has(p));

  if (missing.length > 0) {
    return {
      status: "needs_whitelist",
      missingPrograms: missing,
      swaps,
    };
  }

  // Execute the cached builds sequentially (same routes, same program IDs)
  const signatures: string[] = [];

  for (let i = 0; i < swaps.length; i++) {
    const swap = swaps[i];
    const built = builds[i];

    console.log(
      `[rebalance] Sending swap ${i + 1}/${swaps.length}: ${swap.from.symbol} → ${swap.to.symbol}`,
    );

    const result = await signAndSendTx({
      connection,
      authority,
      ixs: built.ixs,
      alts: built.alts,
    });

    if (result.err) {
      return {
        status: "error",
        signatures,
        swaps,
        error: `Swap ${swap.from.symbol}→${swap.to.symbol} failed: ${JSON.stringify(result.err)}`,
      };
    }

    console.log(`[rebalance] Confirmed: ${result.signature}`);
    signatures.push(result.signature);
  }

  return { status: "success", signatures, swaps };
}
