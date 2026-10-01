/** Local Windows adapter for the four verified Linux-generated external package aliases. */
if (process.platform === "win32") {
  const { registerHooks } = require("node:module");
  const packages = {
    "@coral-xyz/anchor-4e24987da32c7bcf": "@coral-xyz/anchor",
    "@kamino-finance/klend-sdk-c73fa4196c003b37": "@kamino-finance/klend-sdk",
    "@solana/spl-token-e9f425245017069a": "@solana/spl-token",
    "@solana/web3.js-a3a3cf435b607ef1": "@solana/web3.js",
  };
  if (typeof registerHooks !== "function") throw new Error("Local Windows compatibility requires installed Node 24+");
  // Resolve both CommonJS require and dynamic ESM imports through original package exports.
  registerHooks({ resolve(specifier, context, nextResolve) {
    return nextResolve(packages[specifier] || specifier, context);
  } });
}
