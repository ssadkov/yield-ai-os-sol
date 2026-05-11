import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {},
  // Jupiter Lend SDKs ship nested Anchor and load @solana/web3.js dynamically;
  // bundling them with the app's Anchor 0.32 breaks Turbopack, and the dynamic
  // `new Function("import")` we use in jupiterBorrow.ts hides @solana/web3.js
  // from Vercel's NFT. Mark these packages external so Node resolves their
  // nested deps from node_modules at runtime.
  serverExternalPackages: [
    "@jup-ag/lend",
    "@jup-ag/lend-read",
    "@solana/web3.js",
    "@solana/spl-token",
    "@coral-xyz/anchor",
    "axios",
    "jup-lend-read-sdk",
  ],
  // Opaque dynamic imports are invisible to NFT; force the entire trees of the
  // SDK and its runtime peers into the serverless bundle for all API routes.
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./node_modules/@jup-ag/lend/**/*",
      "./node_modules/@jup-ag/lend-read/**/*",
      "./node_modules/jup-lend-read-sdk/**/*",
      "./node_modules/@solana/web3.js/**/*",
      "./node_modules/@solana/spl-token/**/*",
      "./node_modules/@coral-xyz/anchor/**/*",
      "./node_modules/axios/**/*",
    ],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "raw.githubusercontent.com" },
      { protocol: "https", hostname: "tokens.jup.ag" },
      { protocol: "https", hostname: "**.arweave.net" },
      { protocol: "https", hostname: "arweave.net" },
      { protocol: "https", hostname: "cf-ipfs.com" },
      { protocol: "https", hostname: "ipfs.io" },
    ],
  },
};

export default nextConfig;
