export type DragSource = "wallet" | "vault";

/**
 * Snapshot of an asset being dragged. Carries enough info to execute the drop
 * action (deposit / withdraw / activate strategy) without re-querying state.
 */
export interface DragAsset {
  mint: string;
  symbol: string;
  decimals: number;
  /** UI-friendly balance (already divided by 10^decimals). */
  balance: number;
  /** Raw balance string in base units; useful for activate-loop flows. */
  rawAmount?: string;
  logoURI?: string;
  source: DragSource;
}

/** Custom MIME type, so we ignore foreign drags (files, browser images, etc.). */
export const DRAG_MIME = "application/x-yield-ai-asset";

export function serializeDragAsset(asset: DragAsset): string {
  return JSON.stringify(asset);
}

export function tryParseDragAsset(raw: string | null | undefined): DragAsset | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DragAsset;
    if (!parsed.mint || !parsed.symbol || !parsed.source) return null;
    return parsed;
  } catch {
    return null;
  }
}
