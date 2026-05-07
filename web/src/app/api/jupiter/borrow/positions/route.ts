import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";

import { deriveVaultPda } from "@/lib/vault";
import { readVaultJupiterBorrowPositions } from "@/server/agent/protocols/jupiterBorrow";

export const runtime = "nodejs";
export const revalidate = 15;

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length ? value : undefined;
}

export async function GET(req: NextRequest) {
  try {
    const owner = req.nextUrl.searchParams.get("owner");
    const vault = req.nextUrl.searchParams.get("vault");
    if (!owner && !vault) {
      return NextResponse.json(
        { success: false, error: "owner or vault query param is required" },
        { status: 400 },
      );
    }

    const rpcUrl = optionalEnv("RPC_URL") ?? optionalEnv("NEXT_PUBLIC_RPC_URL") ?? "";
    if (!rpcUrl) throw new Error("Missing RPC_URL");

    const vaultPda = vault
      ? new PublicKey(vault)
      : deriveVaultPda(new PublicKey(owner as string))[0];

    const connection = new Connection(rpcUrl, "confirmed");
    const positions = await readVaultJupiterBorrowPositions({
      connection,
      vault: vaultPda,
    });

    return NextResponse.json({
      success: true,
      owner: owner ?? null,
      vault: vaultPda.toBase58(),
      positions,
      fetchedAtMs: Date.now(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
