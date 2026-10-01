import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { bytesToHex, getAddress, hexToBytes, hashTypedData, recoverTypedDataAddress, type Address, type Hex, type TypedDataDefinition } from "viem";

export const EVM_DEVNET_PROGRAM = new PublicKey("8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5");
export const EVM_DEVNET_USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
export const EVM_DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const EVM_DEVNET_GENESIS_HEX = bytesToHex(bs58.decode(EVM_DEVNET_GENESIS));
export const EVM_DEVNET_PROGRAM_HEX = bytesToHex(EVM_DEVNET_PROGRAM.toBytes());
export const EVM_DEVNET_ROUTES = 8;
type AllocationBps = [number, number, number, number, number, number, number, number];

export type EvmSafeStatus = {
  cluster: "devnet";
  program: string;
  owner: Address;
  safe: string;
  ata: string;
  exists: boolean;
  nonce: string;
  allocationBps: number[];
  usdcRaw: string;
  rentPayer: string | null;
  withdrawalEnabled: boolean;
  lifecycleEnabled?: boolean;
  sponsor?: string | null;
};

export type EvmRelayIntent = {
  owner: Address;
  safe: string;
  allocationBps: number[];
  nonce: string;
  deadline: string;
  signature: Hex;
};

export type EvmWithdrawalIntent = {
  action: "withdraw_usdc";
  cluster: "devnet";
  program: string;
  genesisHash: string;
  owner: Address;
  safe: string;
  mint: string;
  amountRaw: string;
  recipientTokenAccount: string;
  recipientOwner: string;
  nonce: string;
  deadline: string;
  signature: Hex;
};
export type EvmCreationIntent = {
  action: "create_safe"; cluster: "devnet"; program: string; genesisHash: string;
  owner: Address; safe: string; mint: string; rentPayer: string;
  nonce: string; deadline: string; signature: Hex;
};
export type EvmCancellationIntent = {
  action: "cancel_intents"; cluster: "devnet"; program: string; genesisHash: string;
  owner: Address; safe: string; nonce: string; deadline: string; signature: Hex;
};
export type EvmLifecycleIntent = EvmCreationIntent | EvmCancellationIntent;
export type EvmOwnerIntent = EvmRelayIntent | EvmWithdrawalIntent | EvmLifecycleIntent;
export const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const HALF_SECP256K1_ORDER = BigInt("0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0");

export function decimalU64(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,19})$/.test(value)) throw new Error(`Invalid ${field}`);
  const parsed = BigInt(value);
  if (parsed > U64_MAX) throw new Error(`Invalid ${field}`);
  return parsed;
}

/** Match the on-chain canonical signature policy before paying to relay. */
export function assertCanonicalEvmSignature(signature: unknown): asserts signature is Hex {
  if (typeof signature !== "string" || !/^0x[\da-fA-F]{130}$/.test(signature)) throw new Error("Invalid EVM signature length");
  const bytes = hexToBytes(signature as Hex);
  if (![0, 1, 27, 28].includes(bytes[64])) throw new Error("Invalid EVM signature recovery byte");
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  if (s === BigInt(0) || s > HALF_SECP256K1_ORDER) throw new Error("Invalid EVM signature: nonzero low-s required");
}

export function deriveEvmSafe(ownerInput: string) {
  const owner = getAddress(ownerInput);
  const ownerBytes = hexToBytes(owner);
  if (ownerBytes.length !== 20 || ownerBytes.every((byte) => byte === 0)) throw new Error("Invalid EVM owner");
  const [safe] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("vault_evm"), ownerBytes], EVM_DEVNET_PROGRAM,
  );
  const ata = getAssociatedTokenAddressSync(EVM_DEVNET_USDC_MINT, safe, true);
  return { owner, ownerBytes, safe, ata };
}

export function kaminoAllocation(percent: number): AllocationBps {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new Error("Kamino target must be 0–100%");
  return [percent * 100, 0, 0, 0, 0, 0, 0, 0];
}

export function validateProbeAllocation(value: unknown): AllocationBps {
  if (!Array.isArray(value) || value.length !== EVM_DEVNET_ROUTES
    || value.some((part) => !Number.isInteger(part) || part < 0 || part > 10_000)
    || value.slice(1).some((part) => part !== 0)) {
    throw new Error("The Devnet probe only supports a Kamino target and zero for other routes");
  }
  return value as unknown as AllocationBps;
}

export function allocationTypedData(safe: PublicKey, allocationBps: number[], nonce: bigint, deadline: bigint) {
  validateProbeAllocation(allocationBps);
  return {
    domain: { name: "Yield AI Safe", version: "1", salt: EVM_DEVNET_PROGRAM_HEX },
    types: {
      SetAllocation: [
        { name: "genesisHash", type: "bytes32" },
        { name: "vault", type: "bytes32" },
        { name: "allocationBps", type: "uint16[8]" },
        { name: "nonce", type: "uint64" },
        { name: "deadline", type: "uint64" },
      ],
    },
    primaryType: "SetAllocation",
    message: {
      genesisHash: EVM_DEVNET_GENESIS_HEX,
      vault: bytesToHex(safe.toBytes()),
      allocationBps: validateProbeAllocation(allocationBps),
      nonce,
      deadline,
    },
  } as const;
}

/** Raw integers and Solana keys are encoded exactly; no EVM chain transaction is requested. */
export function withdrawalTypedData(
  safe: PublicKey, mint: PublicKey, amountRaw: bigint,
  recipientTokenAccount: PublicKey, recipientOwner: PublicKey,
  nonce: bigint, deadline: bigint,
) {
  if (!mint.equals(EVM_DEVNET_USDC_MINT)) throw new Error("Invalid withdrawal mint");
  if (amountRaw <= BigInt(0) || amountRaw > U64_MAX) throw new Error("Invalid withdrawal amountRaw");
  if (nonce <= BigInt(0) || nonce > U64_MAX || deadline < BigInt(0) || deadline > U64_MAX) throw new Error("Invalid nonce or deadline");
  if (recipientTokenAccount.equals(getAssociatedTokenAddressSync(mint, safe, true))) throw new Error("Invalid withdrawal recipient: source account");
  return {
    domain: { name: "Yield AI Safe", version: "1", salt: EVM_DEVNET_PROGRAM_HEX },
    types: {
      WithdrawUsdc: [
        { name: "genesisHash", type: "bytes32" },
        { name: "vault", type: "bytes32" },
        { name: "mint", type: "bytes32" },
        { name: "amountRaw", type: "uint64" },
        { name: "recipientTokenAccount", type: "bytes32" },
        { name: "recipientOwner", type: "bytes32" },
        { name: "nonce", type: "uint64" },
        { name: "deadline", type: "uint64" },
      ],
    },
    primaryType: "WithdrawUsdc",
    message: {
      genesisHash: EVM_DEVNET_GENESIS_HEX, vault: bytesToHex(safe.toBytes()),
      mint: bytesToHex(mint.toBytes()), amountRaw,
      recipientTokenAccount: bytesToHex(recipientTokenAccount.toBytes()),
      recipientOwner: bytesToHex(recipientOwner.toBytes()), nonce, deadline,
    },
  } as const;
}

export function parseWithdrawalIntent(input: Record<string, unknown>): EvmWithdrawalIntent {
  if (input.action !== "withdraw_usdc" || input.cluster !== "devnet"
    || input.program !== EVM_DEVNET_PROGRAM.toBase58() || input.genesisHash !== EVM_DEVNET_GENESIS) {
    throw new Error("Invalid withdrawal action, program or cluster");
  }
  if (typeof input.owner !== "string") throw new Error("Invalid EVM owner");
  const { owner, safe } = deriveEvmSafe(input.owner);
  if (input.safe !== safe.toBase58() || input.mint !== EVM_DEVNET_USDC_MINT.toBase58()) throw new Error("Invalid withdrawal Safe or mint");
  if (typeof input.recipientTokenAccount !== "string" || typeof input.recipientOwner !== "string") throw new Error("Invalid withdrawal recipient");
  let recipient: PublicKey, authority: PublicKey;
  try { recipient = new PublicKey(input.recipientTokenAccount); authority = new PublicKey(input.recipientOwner); }
  catch { throw new Error("Invalid withdrawal recipient"); }
  const amountRaw = decimalU64(input.amountRaw, "amountRaw");
  const nonce = decimalU64(input.nonce, "nonce"), deadline = decimalU64(input.deadline, "deadline");
  withdrawalTypedData(safe, EVM_DEVNET_USDC_MINT, amountRaw, recipient, authority, nonce, deadline);
  assertCanonicalEvmSignature(input.signature);
  return { action: "withdraw_usdc", cluster: "devnet", program: EVM_DEVNET_PROGRAM.toBase58(),
    genesisHash: EVM_DEVNET_GENESIS, owner, safe: safe.toBase58(), mint: EVM_DEVNET_USDC_MINT.toBase58(),
    amountRaw: amountRaw.toString(), recipientTokenAccount: recipient.toBase58(), recipientOwner: authority.toBase58(),
    nonce: nonce.toString(), deadline: deadline.toString(), signature: input.signature };
}

export function isWithdrawalIntent(intent: EvmOwnerIntent): intent is EvmWithdrawalIntent {
  return "action" in intent && intent.action === "withdraw_usdc";
}

export function isLifecycleIntent(intent: EvmOwnerIntent): intent is EvmLifecycleIntent {
  return "action" in intent && (intent.action === "create_safe" || intent.action === "cancel_intents");
}

export function lifecycleTypedData(safe: PublicKey, nonce: bigint, deadline: bigint, rentPayer?: PublicKey): TypedDataDefinition {
  if (nonce <= BigInt(0) || nonce > U64_MAX || deadline < BigInt(0) || deadline > U64_MAX) throw new Error("Invalid nonce or deadline");
  const domain = { name: "Yield AI Safe", version: "1", salt: EVM_DEVNET_PROGRAM_HEX } as const;
  if (rentPayer) {
    if (nonce !== BigInt(1)) throw new Error("Invalid creation nonce");
    return { domain, types: { CreateSafe: [
      { name: "genesisHash", type: "bytes32" }, { name: "vault", type: "bytes32" },
      { name: "mint", type: "bytes32" }, { name: "rentPayer", type: "bytes32" },
      { name: "nonce", type: "uint64" }, { name: "deadline", type: "uint64" },
    ] }, primaryType: "CreateSafe", message: { genesisHash: EVM_DEVNET_GENESIS_HEX,
      vault: bytesToHex(safe.toBytes()), mint: bytesToHex(EVM_DEVNET_USDC_MINT.toBytes()),
      rentPayer: bytesToHex(rentPayer.toBytes()), nonce, deadline } } as const;
  }
  return { domain, types: { CancelIntents: [
    { name: "genesisHash", type: "bytes32" }, { name: "vault", type: "bytes32" },
    { name: "nonce", type: "uint64" }, { name: "deadline", type: "uint64" },
  ] }, primaryType: "CancelIntents", message: { genesisHash: EVM_DEVNET_GENESIS_HEX,
    vault: bytesToHex(safe.toBytes()), nonce, deadline } } as const;
}

export function parseLifecycleIntent(input: Record<string, unknown>): EvmLifecycleIntent {
  if ((input.action !== "create_safe" && input.action !== "cancel_intents") || input.cluster !== "devnet"
    || input.program !== EVM_DEVNET_PROGRAM.toBase58() || input.genesisHash !== EVM_DEVNET_GENESIS) throw new Error("Invalid lifecycle scope");
  if (typeof input.owner !== "string") throw new Error("Invalid EVM owner");
  const { owner, safe } = deriveEvmSafe(input.owner);
  if (input.safe !== safe.toBase58()) throw new Error("Invalid lifecycle Safe");
  const nonce = decimalU64(input.nonce, "nonce"), deadline = decimalU64(input.deadline, "deadline");
  assertCanonicalEvmSignature(input.signature);
  const base = { cluster: "devnet" as const, program: EVM_DEVNET_PROGRAM.toBase58(), genesisHash: EVM_DEVNET_GENESIS,
    owner, safe: safe.toBase58(), nonce: nonce.toString(), deadline: deadline.toString(), signature: input.signature };
  if (input.action === "create_safe") {
    if (input.mint !== EVM_DEVNET_USDC_MINT.toBase58() || typeof input.rentPayer !== "string") throw new Error("Invalid creation mint or sponsor");
    const rentPayer = new PublicKey(input.rentPayer);
    lifecycleTypedData(safe, nonce, deadline, rentPayer);
    return { ...base, action: "create_safe", mint: EVM_DEVNET_USDC_MINT.toBase58(), rentPayer: rentPayer.toBase58() };
  }
  lifecycleTypedData(safe, nonce, deadline);
  return { ...base, action: "cancel_intents" };
}

export function parseEvmOwnerIntent(input: Record<string, unknown>): EvmOwnerIntent {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid intent JSON");
  if (input.action === "withdraw_usdc") return parseWithdrawalIntent(input);
  if (input.action === "create_safe" || input.action === "cancel_intents") return parseLifecycleIntent(input);
  if (input.action !== undefined && input.action !== "set_allocation") throw new Error("Invalid intent action");
  if ((input.cluster !== undefined && input.cluster !== "devnet") || (input.program !== undefined && input.program !== EVM_DEVNET_PROGRAM.toBase58())
    || (input.genesisHash !== undefined && input.genesisHash !== EVM_DEVNET_GENESIS)) throw new Error("Invalid allocation scope");
  if (typeof input.owner !== "string") throw new Error("Invalid EVM owner");
  const { owner, safe } = deriveEvmSafe(input.owner);
  if (input.safe !== safe.toBase58()) throw new Error("Invalid allocation Safe");
  assertCanonicalEvmSignature(input.signature);
  return { owner, safe: safe.toBase58(), allocationBps: validateProbeAllocation(input.allocationBps),
    nonce: decimalU64(input.nonce, "nonce").toString(), deadline: decimalU64(input.deadline, "deadline").toString(), signature: input.signature };
}

export async function verifyEvmIntentSignature(intent: EvmOwnerIntent): Promise<Hex> {
  intent = parseEvmOwnerIntent(intent as unknown as Record<string, unknown>);
  const safe = new PublicKey(intent.safe), nonce = BigInt(intent.nonce), deadline = BigInt(intent.deadline);
  const typed: TypedDataDefinition = isLifecycleIntent(intent)
    ? lifecycleTypedData(safe, nonce, deadline, intent.action === "create_safe" ? new PublicKey(intent.rentPayer) : undefined)
    : isWithdrawalIntent(intent)
      ? withdrawalTypedData(safe, new PublicKey(intent.mint), BigInt(intent.amountRaw), new PublicKey(intent.recipientTokenAccount), new PublicKey(intent.recipientOwner), nonce, deadline)
      : allocationTypedData(safe, intent.allocationBps, nonce, deadline);
  let recovered;
  try { recovered = await recoverTypedDataAddress({ ...typed, signature: intent.signature }); }
  catch { throw new Error("Invalid EVM signature"); }
  if (recovered !== getAddress(intent.owner)) throw new Error("Invalid EVM signature: wrong owner");
  return hashTypedData(typed);
}

export function solanaSignatureBase58(bytes: Uint8Array): string {
  if (bytes.length !== 64) throw new Error("Invalid Solana signature length");
  return bs58.encode(bytes);
}
