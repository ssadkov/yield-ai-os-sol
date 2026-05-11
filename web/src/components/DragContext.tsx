"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { DragAsset } from "@/lib/dragAsset";

interface DragContextValue {
  /** Asset currently being dragged, or null when idle. */
  active: DragAsset | null;
  beginDrag: (asset: DragAsset) => void;
  endDrag: () => void;
}

const DragContext = createContext<DragContextValue | null>(null);

export function DragProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<DragAsset | null>(null);

  const beginDrag = useCallback((asset: DragAsset) => {
    setActive(asset);
  }, []);

  const endDrag = useCallback(() => {
    setActive(null);
  }, []);

  const value = useMemo<DragContextValue>(
    () => ({ active, beginDrag, endDrag }),
    [active, beginDrag, endDrag],
  );

  return <DragContext.Provider value={value}>{children}</DragContext.Provider>;
}

/**
 * Returns drag state. Always safe to call: if no provider is mounted, drag
 * features simply stay idle (drop zones never light up).
 */
export function useDragState(): DragContextValue {
  const ctx = useContext(DragContext);
  if (ctx) return ctx;
  return {
    active: null,
    beginDrag: () => {},
    endDrag: () => {},
  };
}
