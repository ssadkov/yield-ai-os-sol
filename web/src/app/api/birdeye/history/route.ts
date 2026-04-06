import { NextRequest, NextResponse } from "next/server";
import { fetchBirdeyeHistory, sleep } from "@/lib/birdeye";

// Basic global rate limiting flag to ensure sequential requests even from different requests
// Note: In a real serverless environment, this won't be perfectly synchronized across multiple instances.
let lastRequestTime = 0;
const RATE_LIMIT_MS = 1100;

async function waitIfNeeded() {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < RATE_LIMIT_MS) {
    const waitTime = RATE_LIMIT_MS - timeSinceLastRequest;
    await sleep(waitTime);
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const address = searchParams.get("address");
  const type = searchParams.get("type") || "4H";
  
  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - 7 * 24 * 60 * 60;

  const time_from = searchParams.get("time_from") || sevenDaysAgo.toString();
  const time_to = searchParams.get("time_to") || now.toString();

  if (!address) {
    return NextResponse.json(
      { error: "address is required" },
      { status: 400 }
    );
  }

  try {
    await waitIfNeeded();
    
    const data = await fetchBirdeyeHistory(
      address,
      type,
      time_from ? parseInt(time_from) : undefined,
      time_to ? parseInt(time_to) : undefined
    );

    lastRequestTime = Date.now();

    if (!data) {
      return NextResponse.json(
        { error: "Failed to fetch data from Birdeye" },
        { status: 500 }
      );
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("API Error in Birdeye history route:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
