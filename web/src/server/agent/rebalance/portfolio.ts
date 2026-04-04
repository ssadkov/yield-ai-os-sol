import { Connection, PublicKey } from "@solana/web3.js";
import { jupiterFetch } from "../jupiter";
import type { TokenDef, StrategyName, Allocation } from "./tokens";
import { STRATEGY_ALLOCATIONS, USDC } from "./tokens";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "./spl";

export interface VaultInfo {
  strategy: StrategyName;
  owner: PublicKey;
  bump: number;
  allowedPrograms: PublicKey[];
}

export interface TokenBalance {
  token: TokenDef;
  rawAmount: bigint;
  uiAmount: number;
}

export interface PortfolioSnapshot {
  vault: VaultInfo;
  balances: TokenBalance[];
  prices: Map<string, number>;
  totalValueUsd: number;
  allocations: Allocation[];
}

export async function readVaultAccount(
  connection: Connection,
  vaultPda: PublicKey,
): Promise<VaultInfo> {
  const info = await connection.getAccountInfo(vaultPda, "confirmed");
  if (!info) throw new Error(`Vault PDA ${vaultPda.toBase58()} not found`);

  const data = info.data;
  let offset = 8;

  const bump = data.readUInt8(offset);
  offset += 1;

  const owner = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  offset += 32; // agent (skip)

  const strategyIdx = data.readUInt8(offset);
  offset += 1;
  const strategyMap: StrategyName[] = ["Conservative", "Balanced", "Growth"];
  const strategy = strategyMap[strategyIdx];
  if (!strategy) throw new Error(`Unknown strategy index: ${strategyIdx}`);

  offset += 8; // last_rebalance_ts: i64 (skip)

  const programCount = data.readUInt32LE(offset);
  offset += 4;
  const allowedPrograms: PublicKey[] = [];
  for (let i = 0; i < programCount; i++) {
    allowedPrograms.push(new PublicKey(data.subarray(offset, offset + 32)));
    offset += 32;
  }

  return { strategy, owner, bump, allowedPrograms };
}

export async function getTokenBalances(
  connection: Connection,
  vaultPda: PublicKey,
  tokens: TokenDef[],
): Promise<TokenBalance[]> {
  const results: TokenBalance[] = [];

  for (const token of tokens) {
    const mint = new PublicKey(token.mint);
    const programId = token.isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const ata = getAssociatedTokenAddressSync(mint, vaultPda, true, programId);

    let rawAmount = BigInt(0);
    try {
      const resp = await connection.getTokenAccountBalance(ata, "confirmed");
      rawAmount = BigInt(resp.value.amount);
    } catch {
      // ATA doesn't exist yet — balance is 0
    }

    const uiAmount = Number(rawAmount) / 10 ** token.decimals;
    results.push({ token, rawAmount, uiAmount });
  }

  return results;
}

interface JupiterPriceEntry {
  usdPrice: number;
  decimals?: number;
}

type JupiterPriceResponse = Record<string, JupiterPriceEntry>;

export async function fetchPrices(apiKey: string, mints: string[]): Promise<Map<string, number>> {
  const ids = mints.join(",");
  const resp = await jupiterFetch<JupiterPriceResponse>(apiKey, `/price/v3?ids=${ids}`, {
    method: "GET",
  });

  const prices = new Map<string, number>();
  for (const [mint, info] of Object.entries(resp)) {
    if (info?.usdPrice != null) {
      prices.set(mint, info.usdPrice);
    }
  }

  if (!prices.has(USDC.mint)) {
    prices.set(USDC.mint, 1.0);
  }

  return prices;
}

export async function takeSnapshot(args: {
  connection: Connection;
  vaultPda: PublicKey;
  apiKey: string;
}): Promise<PortfolioSnapshot> {
  const { connection, vaultPda, apiKey } = args;

  const vault = await readVaultAccount(connection, vaultPda);
  const allocations = STRATEGY_ALLOCATIONS[vault.strategy];
  const strategyTokens = allocations.map((a) => a.token);

  // Always include USDC — the vault may hold USDC even if the strategy
  // doesn't list it (e.g. Growth). Without it, totalValueUsd would be 0
  // and no swaps would ever be generated.
  const tokenSet = new Map(strategyTokens.map((t) => [t.mint, t]));
  if (!tokenSet.has(USDC.mint)) tokenSet.set(USDC.mint, USDC);
  const tokens = [...tokenSet.values()];
  const mints = tokens.map((t) => t.mint);

  const [balances, prices] = await Promise.all([
    getTokenBalances(connection, vaultPda, tokens),
    fetchPrices(apiKey, mints),
  ]);

  let totalValueUsd = 0;
  for (const b of balances) {
    const price = prices.get(b.token.mint) ?? 0;
    totalValueUsd += b.uiAmount * price;
  }

  return { vault, balances, prices, totalValueUsd, allocations };
}

