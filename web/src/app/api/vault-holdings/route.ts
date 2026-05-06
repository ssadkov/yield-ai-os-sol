import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";

import { fetchPortfolioAssets } from "@/lib/portfolioAssets";
import { deriveVaultPda } from "@/lib/vault";

export const runtime = "nodejs";

function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length ? v : undefined;
}

export async function GET(req: NextRequest) {
  try {
    const owner = req.nextUrl.searchParams.get("owner");
    const vault = req.nextUrl.searchParams.get("vault");
    const includeZero = req.nextUrl.searchParams.get("includeZero") === "1";

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

    const { assets, totalUsd } = await fetchPortfolioAssets(connection, vaultPda, {
      includeSol: false,
      includeZero,
    });

    return NextResponse.json({
      success: true,
      owner: owner ?? null,
      vault: vaultPda.toBase58(),
      totalUsd,
      count: assets.length,
      assets,
      fetchedAtMs: Date.now(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
