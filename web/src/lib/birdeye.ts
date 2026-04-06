const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || "";
const BASE_URL = "https://public-api.birdeye.so";

export interface BirdeyeOHLCV {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  unixTime: number;
}

export interface BirdeyeHistoryResponse {
  success: boolean;
  data: {
    items: BirdeyeOHLCV[];
  };
}

/**
 * Utility to sleep for a given amount of time.
 */
export async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches historical OHLCV data for a token from Birdeye.
 * Respects the 1 request per second rate limit by adding a delay.
 */
export async function fetchBirdeyeHistory(
  address: string,
  type: string = "4H",
  timeFrom?: number,
  timeTo?: number
): Promise<BirdeyeHistoryResponse | null> {
  if (!BIRDEYE_API_KEY) {
    console.error("BIRDEYE_API_KEY is not set");
    return null;
  }

  // Normalize type casing (Birdeye expects 1H, 1D, etc.)
  const normalizedType = type.replace(/h/g, 'H').replace(/d/g, 'D').replace(/w/g, 'W');

  const queryParams = new URLSearchParams({
    address,
    address_type: "token",
    type: normalizedType,
  });

  if (timeFrom) queryParams.append("time_from", timeFrom.toString());
  if (timeTo) queryParams.append("time_to", timeTo.toString());

  try {
    const response = await fetch(
      `${BASE_URL}/defi/history_price?${queryParams.toString()}`,
      {
        headers: {
          "X-API-KEY": BIRDEYE_API_KEY,
          "x-chain": "solana",
        },
      }
    );

    if (response.status === 429) {
        console.warn("Birdeye rate limit exceeded. Retrying after 2s...");
        await sleep(2000);
        return fetchBirdeyeHistory(address, type, timeFrom, timeTo);
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Birdeye API error: ${response.status} ${errorText}`);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error("Error fetching Birdeye history:", error);
    return null;
  }
}
