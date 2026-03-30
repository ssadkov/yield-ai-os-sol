import { PublicKey } from "@solana/web3.js";

export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL || "https://api.mainnet-beta.solana.com";

export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID ||
    "3VtzVhc9vFWb7GaV7TtbZ1nytGzqNsASShAHjiWEFp5s"
);

export const USDC_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_USDC_MINT ||
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

export const USDC_DECIMALS = 6;

export const AGENT_PUBKEY = (() => {
  const raw = process.env.NEXT_PUBLIC_AGENT_PUBKEY;
  if (raw) {
    try {
      return new PublicKey(raw);
    } catch {
      console.warn("Invalid NEXT_PUBLIC_AGENT_PUBKEY, using system program as placeholder");
    }
  }
  return new PublicKey("11111111111111111111111111111112");
})();

export const SOL_MINT = "So11111111111111111111111111111111111111112";

export const USDC_MINT_STR = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
