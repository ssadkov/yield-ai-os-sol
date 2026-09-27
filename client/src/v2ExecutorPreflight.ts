/** Read-only Mainnet preflight for one explicitly selected Yield AI v2 Safe. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const PROGRAM = new PublicKey("yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SHARES = new PublicKey("B9t9wg8r39Lxm2D9Gmqn2rJ5pVQQwjtGBfSsHAXSEnVe");
const PILOT_OWNER = new PublicKey("EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2");
const PILOT_SAFE = new PublicKey("FuDCEZBgp8gxP3gafnHbUJRgGW63VAmtZwsjus1U5qSZ");
const PILOT_EXECUTOR = new PublicKey("3ayNPp7MoihfbnTQ4q6Ge5PVNe9tJsY5betKqKX7C8aH");
const MIN_KAMINO_RAW = 1_000_000n;

function requireProgramAccount(info: Awaited<ReturnType<Connection["getAccountInfo"]>>, label: string) {
  if (!info || !info.owner.equals(PROGRAM)) throw new Error(`${label} missing or owned by another program`);
  return info.data;
}

async function tokenAmount(connection: Connection, mint: PublicKey, owner: PublicKey) {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);
  const account = await connection.getAccountInfo(ata, "finalized");
  if (!account) return 0n;
  if (!account.owner.equals(TOKEN_PROGRAM_ID) || account.data.length !== 165) {
    throw new Error(`Unexpected token account: ${ata.toBase58()}`);
  }
  const balance = await connection.getTokenAccountBalance(ata, "finalized");
  if (balance.value.decimals !== 6) throw new Error(`Unexpected token decimals: ${ata.toBase58()}`);
  return BigInt(balance.value.amount);
}

function raw(value: unknown) { return BigInt(String(value)); }
function usdc(value: bigint) { return `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, "0")}`; }

async function main() {
  if (process.argv.slice(2).length) throw new Error("No arguments accepted: this preflight is pinned to the pilot Safe");
  const endpoint = process.env.V2_MAINNET_RPC_URL;
  if (!endpoint) throw new Error("Set V2_MAINNET_RPC_URL to a private Mainnet RPC endpoint");
  const connection = new Connection(endpoint, "finalized");
  if (await connection.getGenesisHash() !== MAINNET_GENESIS) throw new Error("RPC is not Solana Mainnet");

  const [safe] = PublicKey.findProgramAddressSync([Buffer.from("vault"), PILOT_OWNER.toBuffer()], PROGRAM);
  if (!safe.equals(PILOT_SAFE)) throw new Error("Pilot Safe PDA mismatch");
  const [registry] = PublicKey.findProgramAddressSync([Buffer.from("executor_registry")], PROGRAM);
  const [limits] = PublicKey.findProgramAddressSync([Buffer.from("executor_limits"), safe.toBuffer()], PROGRAM);
  const idl = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../web/src/idl/yield_vault.json"), "utf8")) as Idl;
  if (idl.address !== PROGRAM.toBase58()) throw new Error("Bundled IDL program mismatch");
  const coder = new BorshAccountsCoder(idl);
  const [safeInfo, registryInfo, limitsInfo, executorLamports, idle, shares, slot] = await Promise.all([
    connection.getAccountInfo(safe, "finalized"),
    connection.getAccountInfo(registry, "finalized"),
    connection.getAccountInfo(limits, "finalized"),
    connection.getBalance(PILOT_EXECUTOR, "finalized"),
    tokenAmount(connection, USDC, safe),
    tokenAmount(connection, SHARES, safe),
    connection.getSlot("finalized"),
  ]);
  const vault = coder.decode("Vault", requireProgramAccount(safeInfo, "Safe")) as {
    owner: PublicKey; agent: PublicKey; allocation_bps: number[]; route_principal: unknown[];
  };
  const approved = coder.decode("ExecutorRegistry", requireProgramAccount(registryInfo, "executor registry")) as {
    approved: PublicKey[];
  };
  const policy = coder.decode("ExecutorLimits", requireProgramAccount(limitsInfo, "executor limits")) as {
    vault: PublicKey; enabled: boolean; max_action_usdc: unknown; max_24h_volume_usdc: unknown;
    max_principal_usdc: unknown; hour_epoch: unknown[]; hour_volume: unknown[];
  };
  if (!vault.owner.equals(PILOT_OWNER) || !vault.agent.equals(PILOT_EXECUTOR) ||
      !approved.approved.some((key) => key.equals(PILOT_EXECUTOR)) || !policy.vault.equals(safe)) {
    throw new Error("Owner, assigned executor, whitelist, or policy binding mismatch");
  }
  if (!Array.isArray(policy.hour_volume) || !Array.isArray(policy.hour_epoch) ||
      !Array.isArray(vault.route_principal)) {
    throw new Error(`Unexpected decoded account fields: Vault=${Object.keys(vault)} Limits=${Object.keys(policy)}`);
  }
  const blockTime = await connection.getBlockTime(slot);
  if (blockTime === null) throw new Error("Finalized cluster time unavailable");
  const hour = BigInt(Math.floor(blockTime / 3_600));
  const used24h = policy.hour_volume.reduce<bigint>((sum, volume, index) => {
    const bucket = raw(policy.hour_epoch[index]);
    return bucket >= hour - 23n && bucket <= hour ? sum + raw(volume) : sum;
  }, 0n);
  const principal = raw(vault.route_principal[0]);
  const actionRoom = raw(policy.max_action_usdc);
  const volumeRoom = raw(policy.max_24h_volume_usdc) > used24h ? raw(policy.max_24h_volume_usdc) - used24h : 0n;
  const principalRoom = raw(policy.max_principal_usdc) > principal ? raw(policy.max_principal_usdc) - principal : 0n;
  const targetBps = BigInt(vault.allocation_bps[0]);
  if (vault.allocation_bps.some((bps) => !Number.isInteger(bps) || bps < 0) ||
      vault.allocation_bps.reduce((sum, bps) => sum + bps, 0) > 10_000) {
    throw new Error("Invalid Safe allocation");
  }
  const totalCostBasis = idle + vault.route_principal.reduce<bigint>((sum, item) => sum + raw(item), 0n);
  const allocationRoom = targetBps * totalCostBasis / 10_000n > principal
    ? targetBps * totalCostBasis / 10_000n - principal : 0n;
  const suggested = [idle, actionRoom, volumeRoom, principalRoom, allocationRoom].reduce((a, b) => a < b ? a : b);
  console.log(JSON.stringify({
    cluster: "solana:mainnet", finalizedSlot: slot, program: PROGRAM.toBase58(), safe: safe.toBase58(),
    executor: PILOT_EXECUTOR.toBase58(), executorSol: executorLamports / 1e9,
    allocationBps: Number(targetBps), policyEnabled: policy.enabled,
    idleUsdc: usdc(idle), kaminoSharesRaw: shares.toString(), principalUsdc: usdc(principal),
    actionRoomUsdc: usdc(actionRoom), volumeRoomUsdc: usdc(volumeRoom),
    principalRoomUsdc: usdc(principalRoom), allocationRoomUsdc: usdc(allocationRoom),
    suggestedMaximumDepositUsdc: usdc(suggested),
    readyForSmallDeposit: policy.enabled && principal === 0n && shares === 0n &&
      suggested >= MIN_KAMINO_RAW && executorLamports >= 10_000_000,
    sendsTransaction: false,
  }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
