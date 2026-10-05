export const MOBILE_NETWORKS = {
  devnet: {
    cluster: "devnet", chain: "solana:devnet",
    genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    programId: "8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5",
    usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  },
  mainnet: {
    cluster: "mainnet", chain: "solana:mainnet",
    genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    programId: "yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih",
    usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
} as const;
export type MobileNetwork = (typeof MOBILE_NETWORKS)[keyof typeof MOBILE_NETWORKS];
