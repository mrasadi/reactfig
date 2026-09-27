import type { Effect } from "@reactfig/core";

const BLUR_FN_RE = /blur\(\s*(-?[\d.]+)px\s*\)/;

/**
 * Extracts a `blur(Npx)` radius from a CSS `filter` or `backdrop-filter`
 * computed-style value — e.g. `"blur(4px)"` or a chain like `"blur(4px)
 * brightness(1.1)"` — into design-ir's `layerBlur`/`backgroundBlur`
 * Effect radius. `kind` picks which Effect type the caller wants
 * (`filter` → `layerBlur`, `backdrop-filter` → `backgroundBlur` — see
 * `ElementEvidence.style.filter`/`.backdropFilter`).
 *
 * Only the `blur()` function is mapped — `filter`/`backdrop-filter` can
 * chain arbitrarily many functions (`brightness()`, `contrast()`,
 * `grayscale()`, `drop-shadow()`, `hue-rotate()`, `saturate()`, ...), none
 * of which design-ir/v1's `Effect` union has a shape for. A chain with
 * `blur()` plus other functions still yields a blur Effect (the other
 * functions are silently not represented — a documented, narrower gap
 * than dropping the whole filter); a chain with no `blur()` at all
 * returns null.
 */
export function parseBlur(raw: string | null | undefined, kind: "filter" | "backdrop-filter"): Effect | null {
  if (!raw || raw === "none") return null;
  const match = BLUR_FN_RE.exec(raw);
  if (!match) return null;
  const radius = Number(match[1]);
  if (!Number.isFinite(radius) || radius <= 0) return null;
  return { type: kind === "filter" ? "layerBlur" : "backgroundBlur", radius };
}
