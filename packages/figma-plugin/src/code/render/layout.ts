/// <reference types="@figma/plugin-typings" />
import type { Layout } from "@reactfig/core";

function mapPrimaryAlign(align: Layout["primaryAxisAlign"]): "MIN" | "MAX" | "CENTER" | "SPACE_BETWEEN" {
  switch (align) {
    case "center":
      return "CENTER";
    case "end":
      return "MAX";
    case "spaceBetween":
      return "SPACE_BETWEEN";
    default:
      return "MIN";
  }
}

/**
 * Figma's parent-level counterAxisAlignItems has no "STRETCH" value —
 * see docs/figma-plugin/feasibility.md, correction #2. Returns whether
 * the caller must additionally set `layoutAlign: "STRETCH"` on each
 * direct child (the actual Figma mechanism for this behavior).
 */
function mapCounterAlign(align: Layout["counterAxisAlign"]): { value: "MIN" | "MAX" | "CENTER"; stretchChildren: boolean } {
  switch (align) {
    case "center":
      return { value: "CENTER", stretchChildren: false };
    case "end":
      return { value: "MAX", stretchChildren: false };
    case "stretch":
      return { value: "MIN", stretchChildren: true };
    default:
      return { value: "MIN", stretchChildren: false };
  }
}

/**
 * Applies layout.mode:"flex" as Figma Auto Layout, or layout.mode:"none"
 * (and the CSS Grid absolute-position fallback from ADR 0002, which
 * arrives here as layout.mode:"none" too) as plain absolute positioning.
 * Returns whether the caller must set layoutAlign:"STRETCH" on children
 * after appending them (see mapCounterAlign above) — children don't exist
 * yet at the point this function runs.
 */
export function applyLayout(frame: FrameNode | ComponentNode, layout: Layout | undefined): { stretchChildren: boolean } {
  if (!layout || layout.mode === "none") {
    frame.layoutMode = "NONE";
    return { stretchChildren: false };
  }

  frame.layoutMode = layout.mode === "vertical" ? "VERTICAL" : "HORIZONTAL";
  // A design-ir frame's `bounds` is always a literal measured size captured
  // from the real page — never a hint to "hug contents". Figma's own
  // default the moment `layoutMode` is set to something other than "NONE"
  // is primary-axis AUTO (hug), which silently overrides whatever width/
  // height `resize()` was just called with — this is the "Header renders
  // narrower than its actual full width" bug: a flex row whose children
  // don't naturally fill it (e.g. `justify-content: space-between`) hugs
  // down to just its children's combined width the instant auto layout is
  // turned on, discarding the real captured width entirely. Both axes are
  // set to FIXED unconditionally so a flex frame's size always matches
  // what was actually measured, same as a layoutMode:"NONE" frame already
  // does — regardless of whether stretch alignment separately also needs
  // counterAxisSizingMode:"FIXED" below.
  frame.primaryAxisSizingMode = "FIXED";
  frame.counterAxisSizingMode = "FIXED";
  if (layout.gap !== undefined) frame.itemSpacing = layout.gap;
  if (layout.padding) {
    frame.paddingTop = layout.padding.top;
    frame.paddingRight = layout.padding.right;
    frame.paddingBottom = layout.padding.bottom;
    frame.paddingLeft = layout.padding.left;
  }
  frame.primaryAxisAlignItems = mapPrimaryAlign(layout.primaryAxisAlign);
  const counter = mapCounterAlign(layout.counterAxisAlign);
  frame.counterAxisAlignItems = counter.value;
  if (layout.wrap) frame.layoutWrap = "WRAP";

  return { stretchChildren: counter.stretchChildren };
}
