import type { ColorEvidence } from "./types.js";

/** "16px" -> 16. Returns null for non-px or unparseable values (e.g. "auto", "0"). */
export function parsePx(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const m = /^(-?[\d.]+)px$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parses `rgb(...)` / `rgba(...)` computed-style color strings into 0–1
 * floats. Returns null for "none", "transparent", currentcolor, or
 * anything else not in rgb/rgba form (which is the only form browsers
 * return from getComputedStyle for solid colors).
 */
export function parseColor(raw: string | undefined | null): ColorEvidence | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === "none" || trimmed === "transparent") {
    return { raw: trimmed, parsed: { r: 0, g: 0, b: 0, a: 0 } };
  }
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(trimmed);
  if (!m) return { raw: trimmed, parsed: null };
  const [, rS, gS, bS, aS] = m;
  return {
    raw: trimmed,
    parsed: {
      r: Number(rS) / 255,
      g: Number(gS) / 255,
      b: Number(bS) / 255,
      a: aS !== undefined ? Number(aS) : 1,
    },
  };
}

/**
 * Parses a border-radius computed value into either a single number or a
 * [tl, tr, br, bl] tuple, matching CSS order. Handles two forms:
 *  - length: "8px" or "8px 8px 0px 0px"
 *  - percentage: "50%" or "50% 50% 0% 0%" — real-world computed-style
 *    behavior for border-radius percentages is inconsistent across
 *    engines (some resolve to px before this ever sees it, some don't),
 *    so this always resolves "%" itself against `box` rather than
 *    assuming one behavior — most commonly hit by a circular avatar
 *    (`border-radius: 50%` on a square box), which a percentage this
 *    function can't parse would otherwise silently render as a square
 *    with no radius at all (see mapCornerRadius in buildDesignIR.ts).
 *    Per the CSS spec each corner's horizontal component resolves
 *    against box width, vertical against box height; this only handles
 *    the common single-value-set case (equal horizontal/vertical radii,
 *    the form without a "/" — true elliptical corners with a "/" are a
 *    rarer case Figma's plain `cornerRadius` can't represent exactly
 *    anyway, and are left unparsed as before rather than approximated).
 *    Resolving against `Math.min(width, height)` for a non-square box
 *    is a deliberate, documented approximation, not an exact ellipse.
 */
export function parseCornerRadius(
  raw: string | undefined | null,
  box: { width: number; height: number }
): number | [number, number, number, number] | null {
  if (!raw) return null;
  if (raw.includes("/")) return null; // distinct horizontal/vertical radii — not representable by a single cornerRadius number; left unparsed rather than guessed
  const resolve = (token: string): number | null => {
    const pxVal = parsePx(token);
    if (pxVal !== null) return pxVal;
    const pctMatch = /^(-?[\d.]+)%$/.exec(token.trim());
    if (!pctMatch) return null;
    const pct = Number(pctMatch[1]);
    return Number.isFinite(pct) ? (pct / 100) * Math.min(box.width, box.height) : null;
  };
  const parts = raw.trim().split(/\s+/).map(resolve);
  if (parts.some((p) => p === null)) return null;
  const nums = parts as number[];
  if (nums.length === 1) return nums[0];
  if (nums.length === 4) return [nums[0], nums[1], nums[2], nums[3]];
  // CSS shorthand allows 2 or 3 values too; expand to 4 per CSS rules.
  if (nums.length === 2) return [nums[0], nums[1], nums[0], nums[1]];
  if (nums.length === 3) return [nums[0], nums[1], nums[2], nums[1]];
  return null;
}

/** Maps a raw `display` computed value to the coarse LayoutModeEvidence bucket. */
export function classifyLayoutMode(display: string | undefined | null): "flex" | "grid" | "block" | "inline" | "inline-block" | "other" {
  const d = (display ?? "").trim();
  if (d === "flex" || d === "inline-flex") return "flex";
  if (d === "grid" || d === "inline-grid") return "grid";
  if (d === "block") return "block";
  if (d === "inline") return "inline";
  if (d === "inline-block") return "inline-block";
  return "other";
}

/** Extracts the URL from a `url("...")` / `url('...')` / `url(...)` CSS value. Returns null for gradients or "none". */
export function parseCssUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const m = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/.exec(raw);
  if (!m) return null;
  const url = m[1] ?? m[2] ?? m[3] ?? "";
  return url.trim() || null;
}

/**
 * Splits a CSS value list on commas that are NOT inside a function call's
 * parens — e.g. `"rgba(0, 0, 0, 0.1) 0px 4px, rgba(0, 0, 0, 0.06) 0px 2px"`
 * splits into two shadows, not four fragments; `"linear-gradient(red, blue), url(x.png)"`
 * splits into the gradient and the url, not the gradient's own color-stop
 * commas. Used by box-shadow and gradient parsing, both of which mix
 * top-level (comma-separated shadows/stops/layers) and nested
 * (`rgba(...)`, `linear-gradient(...)`) comma usage in the same string.
 */
export function splitTopLevel(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(raw.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(raw.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}