// Compare a private Helius RPC with the public mainnet RPC.
// Usage: HELIUS_RPC_URL="https://mainnet.helius-rpc.com/?api-key=..." node web/diagnose-rpc.mjs

/** Hide query-string secrets (api-key=...) when printing an RPC URL. */
function redact(url) {
  return url.replace(/([?&][^=]*key=)[^&]+/gi, "$1***");
}

async function diagnoseRPC(name, url) {
  console.log(`\n--- Diagnosing ${name} ---`);
  console.log(`URL: ${redact(url)}`);
  try {
    const start = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getHealth'
      }),
      signal: AbortSignal.timeout(5000) // 5 second timeout
    });
    const duration = Date.now() - start;
    if (response.ok) {
      const json = await response.json();
      console.log(`Status: OK (${duration}ms)`);
      console.log(`Result: ${JSON.stringify(json)}`);
    } else {
      console.log(`Status: Error ${response.status} (${duration}ms)`);
    }
  } catch (err) {
    console.log(`Status: FAILED - ${err.message}`);
  }
}

async function run() {
  const heliusUrl = process.env.HELIUS_RPC_URL;
  if (!heliusUrl) {
    console.error("HELIUS_RPC_URL is not set. Example: HELIUS_RPC_URL=\"https://mainnet.helius-rpc.com/?api-key=<key>\" node web/diagnose-rpc.mjs");
    process.exit(1);
  }
  const publicUrl = "https://api.mainnet-beta.solana.com";

  await diagnoseRPC("Helius", heliusUrl);
  await diagnoseRPC("Public Solana", publicUrl);
}

run();
