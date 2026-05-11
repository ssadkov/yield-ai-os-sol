"use client";

import {
  useState,
  type DragEvent,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import {
  DRAG_MIME,
  tryParseDragAsset,
  type DragAsset,
} from "@/lib/dragAsset";
import { useDragState } from "./DragContext";

interface DropZoneProps extends Omit<HTMLAttributes<HTMLDivElement>, "onDrop" | "children"> {
  /**
   * Decide if the currently dragged asset is acceptable. Called both during
   * hover (to gate visual feedback) and at drop time (to gate the callback).
   * If undefined, the zone always accepts drops.
   */
  accept?: (asset: DragAsset) => boolean;
  /** Called when an acceptable asset is dropped. */
  onAssetDrop: (asset: DragAsset) => void | Promise<void>;
  children?: ReactNode;
  /**
   * Render override that gets state hooks. Use this when the visual highlight
   * must wrap differently or when you want to render extra overlay nodes.
   * Either `children` or `render` must be provided.
   */
  render?: (state: {
    isOver: boolean;
    isCompatible: boolean;
    isDragActive: boolean;
  }) => ReactNode;
  /** Extra class added when an asset is being dragged and this zone matches. */
  compatibleClassName?: string;
  /** Extra class while a compatible asset hovers over this zone. */
  overClassName?: string;
  /** Extra class when an incompatible asset is being dragged. */
  incompatibleClassName?: string;
}

/**
 * Generic HTML5 drop target wired into the shared DragContext. Renders an
 * extra animated outline overlay while a compatible drag is in progress.
 */
export function DropZone({
  accept,
  onAssetDrop,
  className = "",
  compatibleClassName = "",
  overClassName = "",
  incompatibleClassName = "",
  children,
  render,
  ...rest
}: DropZoneProps) {
  const { active } = useDragState();
  const [isOver, setIsOver] = useState(false);
  // dragenter/leave fire for every child; keep a counter so leaving a child
  // doesn't flicker the highlight off.
  const [enterDepth, setEnterDepth] = useState(0);

  const isDragActive = active !== null;
  const isCompatible = active !== null && (!accept || accept(active));

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!isCompatible) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!isCompatible) return;
    event.preventDefault();
    setEnterDepth((d) => d + 1);
    setIsOver(true);
  };

  const handleDragLeave = () => {
    setEnterDepth((d) => {
      const next = Math.max(0, d - 1);
      if (next === 0) setIsOver(false);
      return next;
    });
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsOver(false);
    setEnterDepth(0);
    const raw = event.dataTransfer.getData(DRAG_MIME);
    const asset = tryParseDragAsset(raw);
    if (!asset) return;
    if (accept && !accept(asset)) return;
    void onAssetDrop(asset);
  };

  const stateClass = (() => {
    if (!isDragActive) return "";
    if (isCompatible) {
      return [compatibleClassName, isOver ? overClassName : ""]
        .filter(Boolean)
        .join(" ");
    }
    return incompatibleClassName;
  })();

  return (
    <div
      {...rest}
      className={`${className} ${stateClass}`.trim()}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {render
        ? render({ isOver, isCompatible, isDragActive })
        : children}
    </div>
  );
}
