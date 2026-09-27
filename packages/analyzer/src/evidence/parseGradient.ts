import type { Color, Fill } from "@reactfig/core";
import { parseColor, splitTopLevel } from "./parse.js";

const LINEAR_GRADIENT_RE = /^linear-gradient\((.*)\)$/s;
const RADIAL_GRADIENT_RE = /^radial-gradient\((.*)\)$/s;
const CONIC_GRADIENT_RE = /^conic-gradient\((.*)\)$/s;
const COLOR_RE = /^rgba?\([^)]*\)/;

/**
 * Parses a CSS `radial-gradient(...)` value the same way
 * `parseLinearGradient` handles `linear-gradient(...)` — same "first
 * background layer only" scope, same reliance on getComputedStyle having
 * already resolved colors to rgb()/rgba().
 *
 * Approximate, deliberately, same spirit as `parseLinearGradient`'s own
 * angle handling: only the gradient's *center position* is extracted
 * (via an `at X% Y%` clause, when present — computed style normalizes
 * position keywords like `center`/`top`/`left` to percentages). Shape
 * (`circle`/`ellipse`) and explicit size (`closest-side`,
 * `farthest-corner`, a `<length>` radius, etc.) aren't modeled —
 * design-ir/v1's `radialGradient` Fill has no per-axis radius concept, so
 * every radial gradient renders as Figma's default circular gradient
 * centered at the extracted position. A radial gradient authored with an
 * off-default shape/size still gets a real, positioned gradient rather
 * than nothing — just not a pixel-exact one.
 *
 * Returns null for the same reasons `parseLinearGradient` does (a second/
 * later background layer, an unparseable stop list, `repeating-radial-
 * gradient()` — no "repeat" concept in the schema, same as the linear
 * case).
 */
export function parseRadialGradient(raw: string | null | undefined): Fill | null {
  if (!raw) return null;
  const firstLayer = splitTopLevel(raw)[0]?.trim();
  if (!firstLayer) return null;
  const match = RADIAL_GRADIENT_RE.exec(firstLayer);
  if (!match) return null;

  const args = splitTopLevel(match[1]);
  if (args.length === 0) return null;

  let centerX = 0.5;
  let centerY = 0.5;
  let stopArgs = args;

  // Optional first argument, e.g. "circle at 30% 40%" / "ellipse closest-side at center" /
  // "at 50% 50%" — anything that isn't itself a color stop. Only the "at X Y" position (if
  // any) is extracted; shape/size keywords are recognized just well enough to know this
  // argument isn't a color stop, not otherwise modeled (see doc comment above).
  const first = args[0].trim();
  if (!COLOR_RE.test(first)) {
    const atMatch = /\bat\s+(.+)$/i.exec(first);
    if (atMatch) {
      const pos = parseGradientPosition(atMatch[1].trim());
      if (pos) {
        centerX = pos.x;
        centerY = pos.y;
      }
    }
    stopArgs = args.slice(1);
  }

  const stops = parseColorStops(stopArgs);
  if (stops.length < 2) return null;

  return { type: "radialGradient", stops, centerX, centerY };
}

/**
 * Parses a CSS `conic-gradient([from <angle>] [at <position>], ...)`
 * value. Same scope/approximation posture as `parseRadialGradient`: only
 * the gradient's own two positioning concepts (`from <angle>`, `at X Y`)
 * are extracted; the resulting Figma `GRADIENT_ANGULAR` paint is always a
 * full 360° sweep starting from that angle — CSS's other conic-gradient
 * features (an explicit stop *angle* rather than percentage, `repeating-
 * conic-gradient()`) aren't modeled.
 *
 * Reuses `parseColorStops` for the stop list — its percentage-position
 * parsing (`"10%"`, `"90%"`) already produces exactly the 0–1 fraction-
 * of-the-gradient convention a conic gradient's stops need (0% = the
 * `from` angle, 100% = one full turn back to it), no different handling
 * required from a linear/radial gradient's own stop list.
 */
export function parseConicGradient(raw: string | null | undefined): Fill | null {
  if (!raw) return null;
  const firstLayer = splitTopLevel(raw)[0]?.trim();
  if (!firstLayer) return null;
  const match = CONIC_GRADIENT_RE.exec(firstLayer);
  if (!match) return null;

  const args = splitTopLevel(match[1]);
  if (args.length === 0) return null;

  let centerX = 0.5;
  let centerY = 0.5;
  let startAngleDeg = 0;
  let stopArgs = args;

  // Optional first argument, e.g. "from 45deg at 30% 40%" / "from 0.25turn" / "at center".
  const first = args[0].trim();
  if (!COLOR_RE.test(first)) {
    const fromMatch = /\bfrom\s+(-?[\d.]+)(deg|turn|rad|grad)\b/i.exec(first);
    if (fromMatch) startAngleDeg = toDegrees(Number.parseFloat(fromMatch[1]), fromMatch[2].toLowerCase());
    const atMatch = /\bat\s+(.+)$/i.exec(first);
    if (atMatch) {
      const pos = parseGradientPosition(atMatch[1].trim());
      if (pos) {
        centerX = pos.x;
        centerY = pos.y;
      }
    }
    stopArgs = args.slice(1);
  }

  const stops = parseColorStops(stopArgs);
  if (stops.length < 2) return null;

  return { type: "conicGradient", stops, centerX, centerY, startAngleDeg };
}

function toDegrees(value: number, unit: string): number {
  switch (unit) {
    case "turn":
      return value * 360;
    case "rad":
      return (value * 180) / Math.PI;
    case "grad":
      return value * 0.9;
    default:
      return value; // deg
  }
}

/** `"50% 50%"` / `"30% 40%"` / `"center"` — percentage or `center` keyword only (see parseRadialGradient's doc comment for why shape/length forms aren't handled). Null for anything else, leaving the caller's default (0.5, 0.5) in place rather than guessing. */
function parseGradientPosition(text: string): { x: number; y: number } | null {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const toFraction = (t: string): number | null => {
    if (t === "center") return 0.5;
    const m = /^(-?[\d.]+)%$/.exec(t);
    return m ? Number.parseFloat(m[1]) / 100 : null;
  };
  const x = toFraction(tokens[0]);
  const y = tokens.length > 1 ? toFraction(tokens[1]) : 0.5;
  if (x === null || y === null) return null;
  return { x, y };
}

/**
 * Parses a CSS `linear-gradient(...)` value — the raw computed
 * `background-image` string captured in `ElementEvidence.style.backgroundImage`
 * (see evidence/types.ts) — into a design-ir `Fill` of type
 * `linearGradient`.
 *
 * Returns null for anything that isn't a plain `linear-gradient(...)` as
 * the FIRST comma-separated background layer:
 *  - `radial-gradient()` / `conic-gradient()` — handled by the separate
 *    `parseRadialGradient`/`parseConicGradient` below, not this function.
 *  - `repeating-linear-gradient()` — no "repeat" concept in the schema.
 *  - A second/later background layer (e.g. `linear-gradient(...), url(...)`)
 *    — only the first (topmost, per CSS's layer-stacking order) layer is
 *    considered; a background stack beyond that is a separate,
 *    documented gap, not silently mis-rendered here.
 *  - Anything genuinely unparseable.
 *
 * `boxSize`, when available (the element's own bounds), is used to
 * compute the CSS-spec-accurate angle for a `to <corner>` direction,
 * which depends on the element's aspect ratio — see `cssCornerAngleDeg`.
 * Side keywords (`to top` / `to right` / etc.) and an explicit `<angle>deg`
 * don't need it.
 */
export function parseLinearGradient(raw: string | null | undefined, boxSize?: { width: number; height: number }): Fill | null {
  if (!raw) return null;
  const firstLayer = splitTopLevel(raw)[0]?.trim();
  if (!firstLayer) return null;
  const match = LINEAR_GRADIENT_RE.exec(firstLayer);
  if (!match) return null;

  const args = splitTopLevel(match[1]);
  if (args.length === 0) return null;

  let cssAngleDeg = 180; // CSS default direction when no angle/side is given: "to bottom".
  let stopArgs = args;
  const direction = parseDirection(args[0], boxSize);
  if (direction !== null) {
    cssAngleDeg = direction;
    stopArgs = args.slice(1);
  }

  const stops = parseColorStops(stopArgs);
  if (stops.length < 2) return null; // not a meaningful gradient without at least 2 resolvable stops

  return { type: "linearGradient", stops, angleDeg: cssAngleToDesignIrAngle(cssAngleDeg) };
}

/**
 * design-ir's `angleDeg` is NOT the same convention as CSS's own
 * `<angle>` for `linear-gradient()` (CSS: 0deg = "to top", clockwise).
 * The renderer's `angleToGradientTransform` (packages/figma-plugin/src/
 * code/render/style.ts) leaves Figma's gradient untransformed at
 * angleDeg=0, and Figma's own untransformed default gradient direction
 * is left-to-right — i.e. design-ir's angleDeg=0 means "pointing right",
 * confirmed by evaluating that transform's handle positions at 0° and
 * 90° (0° → (0,0.5)→(1,0.5), left-to-right; 90° → (0.5,0)→(0.5,1),
 * top-to-bottom). CSS's own "pointing right" is 90°. So: designIrAngle =
 * cssAngle - 90. This conversion is internally verified against the
 * existing (unmodified) transform's own matrix output — what's still
 * unverified, same as before this change (see the transform's own
 * comment and docs/figma-plugin/feasibility.md), is whether Figma
 * itself renders that transform exactly as assumed; there's no way to
 * confirm that without a live Figma instance.
 */
function cssAngleToDesignIrAngle(cssAngleDeg: number): number {
  return normalizeAngle(cssAngleDeg - 90);
}

function normalizeAngle(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Returns a CSS-convention angle (0=to top, clockwise) for an `<angle>deg` or `to <side-or-corner>` first argument, or null if `token` isn't a direction at all (i.e. it's actually the first color stop). */
function parseDirection(token: string, boxSize?: { width: number; height: number }): number | null {
  const trimmed = token.trim();
  const angleMatch = /^(-?[\d.]+)deg$/.exec(trimmed);
  if (angleMatch) return normalizeAngle(Number.parseFloat(angleMatch[1]));

  if (!trimmed.startsWith("to ")) return null;
  const sides = new Set(trimmed.slice(3).trim().split(/\s+/).filter(Boolean));
  if (sides.size === 1) {
    if (sides.has("top")) return 0;
    if (sides.has("right")) return 90;
    if (sides.has("bottom")) return 180;
    if (sides.has("left")) return 270;
    return null;
  }
  if (sides.size === 2 && (sides.has("top") || sides.has("bottom")) && (sides.has("left") || sides.has("right"))) {
    return cssCornerAngleDeg(sides.has("top"), sides.has("right"), boxSize);
  }
  return null;
}

/**
 * The CSS-spec gradient-line angle for a `to <corner>` direction depends
 * on the element's aspect ratio: the line points from the box's center
 * exactly at the named corner, so a wide box's "to top right" tilts
 * closer to horizontal than a square box's (a plain 45° for every
 * corner, independent of aspect ratio, is a common approximation in
 * simpler tools, but isn't what CSS actually does).
 *
 * Derivation: define a unit direction vector (dxEast, dyNorth) toward
 * the target corner (dyNorth positive = upward), then the CSS-convention
 * angle (0=north, clockwise) is atan2(dxEast, dyNorth) — verified
 * self-consistent against the 4 plain side keywords (dxEast=1,dyNorth=0
 * → atan2(1,0)=90°, matching "to right"=90°, etc.). For "to top right",
 * the corner direction is (+width, +height), so angle =
 * atan2(width, height); a square box (width=height) then gives exactly
 * 45°, matching the well-known symmetric case.
 *
 * Falls back to a fixed 45°-multiple (as if the box were square) when
 * `boxSize` is unavailable or degenerate (zero width/height) — a
 * reasonable default, not a precise CSS-spec match, for that case only.
 */
function cssCornerAngleDeg(top: boolean, right: boolean, boxSize?: { width: number; height: number }): number {
  const hasRealSize = !!boxSize && boxSize.width > 0 && boxSize.height > 0;
  const width = hasRealSize ? boxSize!.width : 1;
  const height = hasRealSize ? boxSize!.height : 1;
  const dxEast = right ? width : -width;
  const dyNorth = top ? height : -height;
  return normalizeAngle((Math.atan2(dxEast, dyNorth) * 180) / Math.PI);
}

interface RawStop {
  color: Color;
  /** 0–1, or null when this stop had no explicit position and needs auto-distribution. */
  position: number | null;
}

function parseColorStops(stopArgs: string[]): { position: number; color: Color }[] {
  const raw: RawStop[] = [];
  for (const arg of stopArgs) {
    const trimmed = arg.trim();
    const colorMatch = COLOR_RE.exec(trimmed);
    if (!colorMatch) return []; // an unparseable stop invalidates the whole gradient rather than fabricating a partial one
    const color = parseColor(colorMatch[0]);
    if (!color?.parsed) return [];
    const rest = trimmed.slice(colorMatch[0].length).trim();
    // Only a percentage position is handled — a length-based stop (e.g.
    // "20px", rare in practice for a computed value derived from a
    // percentage-authored gradient) is left unpositioned (auto-distributed)
    // rather than guessed. A double-position hint ("red 10% 20%") only
    // uses the first of the two — the second (a hard-stop hint) is a
    // finer CSS feature not represented in design-ir/v1's Fill schema.
    const posMatch = /^(-?[\d.]+)%/.exec(rest);
    raw.push({ color: color.parsed, position: posMatch ? Number.parseFloat(posMatch[1]) / 100 : null });
  }
  return distributeStopPositions(raw);
}

/**
 * Implements CSS's color-stop auto-positioning: an unpositioned first/last
 * stop defaults to 0/1, an unpositioned stop between two positioned ones
 * is evenly distributed across that gap, and any position that would
 * regress before the previous stop's is clamped up to it (CSS requires
 * stop positions to be monotonically non-decreasing).
 */
function distributeStopPositions(raw: RawStop[]): { position: number; color: Color }[] {
  if (raw.length === 0) return [];
  const positions: (number | null)[] = raw.map((s) => s.position);
  if (positions[0] === null) positions[0] = 0;
  if (positions[positions.length - 1] === null) positions[positions.length - 1] = 1;

  let i = 0;
  while (i < positions.length) {
    if (positions[i] !== null) {
      i++;
      continue;
    }
    let j = i;
    while (positions[j] === null) j++;
    const start = positions[i - 1] as number;
    const end = positions[j] as number;
    const span = j - (i - 1);
    for (let k = i; k < j; k++) positions[k] = start + ((end - start) * (k - (i - 1))) / span;
    i = j;
  }

  for (let k = 1; k < positions.length; k++) {
    const prev = positions[k - 1] as number;
    if ((positions[k] as number) < prev) positions[k] = prev;
  }

  return raw.map((s, idx) => ({ position: positions[idx] as number, color: s.color }));
}