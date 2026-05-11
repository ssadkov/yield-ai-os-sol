import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {},
  // Keep these packages out of the server bundle so Node loads them from
  // node_modules at runtime. @jup-ag/lend is loaded via `new Function("import")`
  // which webpack/nft can't statically trace, so without this Vercel's
  // serverless function ships without @solana/web3.js (or ships @jup-ag/lend
  // without its peer @solana/web3.js resolvable). See Jupiter Lend SDK runtime
  // error: "Cannot find package '@solana/web3.js' imported from ...@jup-ag/lend/..."
  serverExternalPackages: [
    "@jup-ag/lend",
    "@jup-ag/lend-read",
    "@solana/web3.js",
    "@solana/spl-token",
    "@coral-xyz/anchor",
    "bn.js",
    "bs58",
  ],
  // Force-include the actual files of these packages into the function bundle
  // for routes that touch Jupiter Lend; nft otherwise prunes them because the
  // SDK is loaded dynamically.
  outputFileTracingIncludes: {
    "/api/jupiter/borrow/**/*": [
      "node_modules/@jup-ag/lend/**/*",
      "node_modules/@jup-ag/lend-read/**/*",
      "node_modules/@solana/web3.js/**/*",
    ],
    "/api/rebalance/**/*": [
      "node_modules/@jup-ag/lend/**/*",
      "node_modules/@jup-ag/lend-read/**/*",
      "node_modules/@solana/web3.js/**/*",
    ],
    "/api/cron/rebalance/**/*": [
      "node_modules/@jup-ag/lend/**/*",
      "node_modules/@jup-ag/lend-read/**/*",
      "node_modules/@solana/web3.js/**/*",
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
