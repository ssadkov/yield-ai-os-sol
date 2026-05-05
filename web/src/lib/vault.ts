import { Program, AnchorProvider, type Idl, BN } from "@coral-xyz/anchor";
import {
  PublicKey,
  Connection,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { PROGRAM_ID, USDC_MINT, AGENT_PUBKEY } from "./constants";
import idlJson from "@/idl/yield_vault.json";

export type StrategyName = "Conservative" | "Balanced" | "Aggressive";

function strategyArg(name: StrategyName) {
  const map: Record<StrategyName, object> = {
    Conservative: { conservative: {} },
    Balanced: { balanced: {} },
    Aggressive: { growth: {} },
  };
  return map[name];
}

export interface VaultAccount {
  bump: number;
  owner: PublicKey;
  agent: PublicKey;
  strategy: { conservative?: object; balanced?: object; growth?: object };
  lastRebalanceTs: BN;
  allowedPrograms: PublicKey[];
}

export function deriveVaultPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer()],
    PROGRAM_ID
  );
}

function getProgram(provider: AnchorProvider): Program {
  return new Program(idlJson as Idl, provider);
}

export async function fetchVaultAccount(
  connection: Connection,
  owner: PublicKey
): Promise<VaultAccount | null> {
  const [vaultPda] = deriveVaultPda(owner);
  const info = await connection.getAccountInfo(vaultPda);
  if (!info) return null;

  const provider = new AnchorProvider(
    connection,
    { publicKey: owner, signTransaction: async <T,>(t: T) => t, signAllTransactions: async <T,>(t: T[]) => t } as never,
    { preflightCommitment: "confirmed" }
  );
  const program = getProgram(provider);
  try {
    const vault = await (program.account as Record<string, { fetch(addr: PublicKey): Promise<VaultAccount> }>)["vault"].fetch(vaultPda);
    return vault;
  } catch {
    return null;
  }
}

export function parseStrategy(s: VaultAccount["strategy"]): StrategyName {
  if ("conservative" in s) return "Conservative";
  if ("balanced" in s) return "Balanced";
  return "Aggressive";
}

/**
 * Known program IDs the vault may CPI into.
 * Max 64 entries on-chain; keep this list merged with existing vault entries
 * when updating, because set_allowed_programs rewrites the whole list.
 */
export const DEFAULT_ALLOWED_PROGRAMS: PublicKey[] = [
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",  // Jupiter Aggregator v6
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",   // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",   // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",  // Associated Token
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",   // Orca Whirlpool
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",  // Raydium AMM v4
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",  // Raydium CLMM
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",   // Meteora DLMM
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB",  // Meteora Pools
  "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY",   // Phoenix
  "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX",    // Serum/OpenBook
  "opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb",   // OpenBook v2
  "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9",   // Jupiter Earn
  "jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi",   // Jupiter Borrow
  "11111111111111111111111111111111",              // System Program
].map((s) => new PublicKey(s));

export function mergeAllowedPrograms(
  existing: PublicKey[],
  required: PublicKey[] = DEFAULT_ALLOWED_PROGRAMS,
): PublicKey[] {
  const merged = new Map<string, PublicKey>();
  for (const p of existing) merged.set(p.toBase58(), p);
  for (const p of required) merged.set(p.toBase58(), p);
  return [...merged.values()];
}

export function getMissingDefaultAllowedPrograms(vault: VaultAccount | null): PublicKey[] {
  if (!vault) return [];
  const existing = new Set(vault.allowedPrograms.map((p) => p.toBase58()));
  return DEFAULT_ALLOWED_PROGRAMS.filter((p) => !existing.has(p.toBase58()));
}

export async function initializeVault(
  provider: AnchorProvider,
  strategy: StrategyName
) {
  const program = getProgram(provider);
  const owner = provider.wallet.publicKey;

  const sig = await program.methods
    .initialize(AGENT_PUBKEY, strategyArg(strategy), DEFAULT_ALLOWED_PROGRAMS)
    .accounts({
      owner,
      usdcMint: USDC_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  return sig;
}

export async function depositUsdc(
  provider: AnchorProvider,
  amount: number
) {
  const program = getProgram(provider);
  const owner = provider.wallet.publicKey;
  const [vaultPda] = deriveVaultPda(owner);

  const ownerAta = await getAssociatedTokenAddress(USDC_MINT, owner);
  const vaultAta = await getAssociatedTokenAddress(USDC_MINT, vaultPda, true);

  const sig = await program.methods
    .deposit(new BN(amount))
    .accounts({
      owner,
      usdcMint: USDC_MINT,
      ownerUsdcAta: ownerAta,
      vaultUsdcAta: vaultAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  return sig;
}

export async function withdrawUsdc(
  provider: AnchorProvider,
  amount: number
) {
  const program = getProgram(provider);
  const owner = provider.wallet.publicKey;
  const [vaultPda] = deriveVaultPda(owner);

  const ownerAta = await getAssociatedTokenAddress(USDC_MINT, owner);
  const vaultAta = await getAssociatedTokenAddress(USDC_MINT, vaultPda, true);

  const sig = await program.methods
    .withdraw(new BN(amount))
    .accounts({
      owner,
      usdcMint: USDC_MINT,
      ownerUsdcAta: ownerAta,
      vaultUsdcAta: vaultAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  return sig;
}

export async function setAllowedPrograms(
  provider: AnchorProvider,
  programs: PublicKey[],
) {
  if (programs.length > 64) {
    throw new Error("Allowed program list cannot exceed 64 entries");
  }

  const program = getProgram(provider);
  const owner = provider.wallet.publicKey;

  const sig = await program.methods
    .setAllowedPrograms(programs)
    .accounts({ owner, systemProgram: SystemProgram.programId })
    .rpc();

  return sig;
}

export async function getVaultUsdcBalance(
  connection: Connection,
  owner: PublicKey
): Promise<number> {
  const [vaultPda] = deriveVaultPda(owner);
  const vaultAta = await getAssociatedTokenAddress(USDC_MINT, vaultPda, true);
  try {
    const balance = await connection.getTokenAccountBalance(vaultAta);
    return Number(balance.value.amount);
  } catch {
    return 0;
  }
}
