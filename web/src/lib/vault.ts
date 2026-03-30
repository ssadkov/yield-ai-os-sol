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

export type StrategyName = "Conservative" | "Balanced" | "Growth";

function strategyArg(name: StrategyName) {
  const map: Record<StrategyName, object> = {
    Conservative: { conservative: {} },
    Balanced: { balanced: {} },
    Growth: { growth: {} },
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
  return "Growth";
}

export async function initializeVault(
  provider: AnchorProvider,
  strategy: StrategyName
) {
  const program = getProgram(provider);
  const owner = provider.wallet.publicKey;

  const sig = await program.methods
    .initialize(AGENT_PUBKEY, strategyArg(strategy), [])
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
