/// <reference types="@figma/plugin-typings" />
import type { Bounds } from "@reactfig/core";

export const ZERO_BOUNDS: Bounds = { x: 0, y: 0, width: 0, height: 0 };

/**
 * IR `bounds` are absolute/document-space (see docs/figma-plugin/
 * feasibility.md, correction #1 — this corrected a stale Phase 2 doc
 * comment claiming parent-relative). Figma's node.x/node.y ARE
 * parent-relative. Every place a node's position is set from IR bounds
 * must go through this function.
 */
export function relativePosition(child: Bounds, parent: Bounds): { x: number; y: number } {
  return { x: child.x - parent.x, y: child.y - parent.y };
}

/** Figma rejects zero/negative dimensions on resize() — clamp to a minimal positive size rather than throwing on a degenerate IR bounds. */
export function safeSize(bounds: Bounds): { width: number; height: number } {
  return { width: Math.max(bounds.width, 0.01), height: Math.max(bounds.height, 0.01) };
}

/**
 * Sets `child.x`/`child.y` from IR bounds, correctly, EVEN when `container`
 * has Figma Auto Layout enabled — see docs/adr/0031.
 *
 * Auto Layout is not merely a hint: once a frame's `layoutMode` is
 * anything other than `"NONE"`, Figma's own layout engine positions every
 * child of that frame itself (padding + itemSpacing + alignment + append
 * order) — a plain `child.x = ...` assignment on such a child is silently
 * ineffective (this is documented, intentional Figma Plugin API behavior,
 * not a bug in Figma or in `relativePosition` above, whose math is
 * correct in isolation). `layoutPositioning = "ABSOLUTE"` is Figma's own
 * supported escape hatch — see the official example in
 * `@figma/plugin-typings`' own doc comment for `layoutPositioning`, which
 * sets EXACTLY `child.layoutPositioning = "ABSOLUTE"` before `child.x =`/
 * `child.y =`, the identical order this function follows. The frame
 * itself is untouched — it remains a real, editable Figma Auto Layout
 * frame (padding/gap/alignment all still genuinely apply to whichever
 * children, if any, are NOT marked ABSOLUTE); this only opts each
 * INDIVIDUAL child fully covered by captured pixel geometry out of the
 * flow algorithm that would otherwise silently discard that geometry.
 *
 * `"layoutMode" in container` is false for a `PageNode` (page-level
 * content is never itself an auto-layout child) and for any container
 * type that doesn't support Auto Layout at all — both correctly skip this
 * entirely and fall through to a plain assignment.
 */
export function placeInParent(child: SceneNode, bounds: Bounds, parentBounds: Bounds, container: FrameNode | ComponentNode | PageNode): void {
  if ("layoutMode" in container && container.layoutMode !== "NONE" && "layoutPositioning" in child) {
    child.layoutPositioning = "ABSOLUTE";
  }
  const pos = relativePosition(bounds, parentBounds);
  child.x = pos.x;
  child.y = pos.y;
}
