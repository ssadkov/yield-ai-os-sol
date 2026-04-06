
async function diagnoseRPC(name, url) {
  console.log(`\n--- Diagnosing ${name} ---`);
  console.log(`URL: ${url}`);
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
  const heliusUrl = "https://mainnet.helius-rpc.com/?api-key=29798653-2d13-4d8a-96ad-df70b015e234";
  const publicUrl = "https://api.mainnet-beta.solana.com";

  await diagnoseRPC("Helius", heliusUrl);
  await diagnoseRPC("Public Solana", publicUrl);
}

run();
