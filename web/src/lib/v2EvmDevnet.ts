import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { bytesToHex, getAddress, hexToBytes, type Address, type Hex } from "viem";

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
};

export type EvmRelayIntent = {
  owner: Address;
  safe: string;
  allocationBps: number[];
  nonce: string;
  deadline: string;
  signature: Hex;
};

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
