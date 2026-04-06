
async function testHelius() {
  const RPC_URL = "https://mainnet.helius-rpc.com/?api-key=29798653-2d13-4d8a-96ad-df70b015e234";
  console.log("Testing Helius RPC:", RPC_URL);
  
  try {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "test",
        method: "getAsset",
        params: {
          id: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" // USDC
        }
      })
    });

    if (response.ok) {
      const json = await response.json();
      console.log("Helius response OK:", JSON.stringify(json, null, 2));
    } else {
      console.log("Helius response NOT OK:", response.status, response.statusText);
      const text = await response.text();
      console.log("Response body:", text);
    }
  } catch (err) {
    console.error("Helius request failed:", err);
  }
}

testHelius();
