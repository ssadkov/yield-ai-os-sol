import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {},
  // Jupiter Lend SDKs ship nested Anchor; bundling them with app Anchor 0.32 breaks Turbopack.
  // Mark external so Node loads published `dist/` + nested deps from node_modules at runtime.
  serverExternalPackages: ["@jup-ag/lend", "@jup-ag/lend-read"],
  // Opaque dynamic imports are invisible to NFT; ensure serverless traces still ship these trees.
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./node_modules/@jup-ag/lend/**/*",
      "./node_modules/@jup-ag/lend-read/**/*",
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
