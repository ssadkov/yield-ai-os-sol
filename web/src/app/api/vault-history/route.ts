import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchVaultHistory, type VaultPnlData } from "@/lib/vaultHistory";

const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL || "https://api.mainnet-beta.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID ||
    "3VtzVhc9vFWb7GaV7TtbZ1nytGzqNsASShAHjiWEFp5s",
);

function deriveVaultPda(owner: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer()],
    PROGRAM_ID,
  );
  return pda;
}

export async function GET(req: NextRequest) {
  const ownerStr = req.nextUrl.searchParams.get("owner");
  if (!ownerStr) {
    return NextResponse.json(
      { error: "owner query parameter is required" },
      { status: 400 },
    );
  }

  let owner: PublicKey;
  try {
    owner = new PublicKey(ownerStr);
  } catch {
    return NextResponse.json(
      { error: "invalid owner public key" },
      { status: 400 },
    );
  }

  try {
    const connection = new Connection(RPC_URL, "confirmed");
    const vaultPda = deriveVaultPda(owner);
    const data: VaultPnlData = await fetchVaultHistory(
      connection,
      PROGRAM_ID,
      vaultPda,
    );
    return NextResponse.json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to fetch vault history: ${message}` },
      { status: 500 },
    );
  }
}
