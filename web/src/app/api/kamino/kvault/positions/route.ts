import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { deriveVaultPda } from "@/lib/vault";

export const runtime = "nodejs";
export const revalidate = 30;

const KAMINO_API_BASE = "https://api.kamino.finance";

type KaminoPosition = {
  vaultAddress: string;
  stakedShares: string;
  unstakedShares: string;
  totalShares: string;
};

type KaminoVault = {
  address: string;
  state?: {
    name?: string | number[];
    tokenMint?: string;
    tokenMintDecimals?: number | string;
    sharesMint?: string;
    sharesMintDecimals?: number | string;
  };
};

type KaminoVaultMetrics = {
  tokenPrice?: string;
  tokensPerShare?: string;
  sharePrice?: string;
  apy?: string;
};

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${KAMINO_API_BASE}${path}`, {
    headers: { accept: "application/json" },
    next: { revalidate },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Kamino request failed (${response.status}): ${text.slice(0, 500)}`);
  }
  return JSON.parse(text) as T;
}

function decodeVaultName(name: string | number[] | undefined, fallback: string): string {
  if (typeof name === "string") return name.replace(/\0+$/, "");
  if (Array.isArray(name)) {
    return Buffer.from(name).toString("utf8").replace(/\0+$/, "");
  }
  return fallback;
}

async function enrichPosition(position: KaminoPosition) {
  const [vaultInfo, metrics] = await Promise.all([
    fetchJson<KaminoVault>(`/kvaults/vaults/${position.vaultAddress}`),
    fetchJson<KaminoVaultMetrics>(`/kvaults/vaults/${position.vaultAddress}/metrics`),
  ]);

  const shares = Number(position.totalShares);
  const tokensPerShare = Number(metrics.tokensPerShare ?? 0);
  const tokenPrice = Number(metrics.tokenPrice ?? 0);
  const underlyingAmount = Number.isFinite(shares * tokensPerShare)
    ? shares * tokensPerShare
    : null;
  const underlyingUsd =
    underlyingAmount !== null && Number.isFinite(underlyingAmount * tokenPrice)
      ? underlyingAmount * tokenPrice
      : null;

  return {
    ...position,
    vaultName: decodeVaultName(vaultInfo.state?.name, position.vaultAddress),
    tokenMint: vaultInfo.state?.tokenMint ?? null,
    tokenMintDecimals: vaultInfo.state?.tokenMintDecimals ?? null,
    sharesMint: vaultInfo.state?.sharesMint ?? null,
    tokensPerShare: metrics.tokensPerShare ?? null,
    sharePrice: metrics.sharePrice ?? null,
    tokenPrice: metrics.tokenPrice ?? null,
    apy: metrics.apy ?? null,
    underlyingAmount,
    underlyingUsd,
  };
}

export async function GET(req: NextRequest) {
  try {
    const owner = req.nextUrl.searchParams.get("owner");
    const vault = req.nextUrl.searchParams.get("vault");
    const kvault = req.nextUrl.searchParams.get("kvault");

    if (!owner && !vault) {
      return NextResponse.json(
        { success: false, error: "owner or vault query param is required" },
        { status: 400 },
      );
    }

    const vaultPda = vault
      ? new PublicKey(vault)
      : deriveVaultPda(new PublicKey(owner as string))[0];
    const path = kvault
      ? `/kvaults/users/${vaultPda.toBase58()}/positions/${kvault}`
      : `/kvaults/users/${vaultPda.toBase58()}/positions`;

    const rawPositions = await fetchJson<KaminoPosition | KaminoPosition[]>(path);
    const positionList = Array.isArray(rawPositions) ? rawPositions : [rawPositions];
    const enrichedPositions = await Promise.all(positionList.map(enrichPosition));

    return NextResponse.json({
      success: true,
      owner: owner ?? null,
      vault: vaultPda.toBase58(),
      kvault: kvault ?? null,
      positions: kvault ? enrichedPositions[0] ?? null : enrichedPositions,
      fetchedAtMs: Date.now(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
