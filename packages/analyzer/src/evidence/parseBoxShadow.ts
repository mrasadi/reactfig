import type { Effect } from "@reactfig/core";
import { parseColor, splitTopLevel } from "./parse.js";

const COLOR_RE = /rgba?\([^)]*\)/;
const LENGTH_RE = /-?[\d.]+px/g;

/**
 * Parses a CSS `box-shadow` computed-style value (as captured verbatim in
 * `ElementEvidence.style.boxShadow` — see evidence/types.ts) into
 * design-ir `Effect`s (`dropShadow` for a normal shadow, `innerShadow`
 * for one with the `inset` keyword).
 *
 * getComputedStyle always resolves colors to rgb()/rgba() and lengths to
 * px — the same normalized form `parseColor`/`parsePx` already assume
 * elsewhere in this module — so this only needs to handle that resolved
 * form, not the full box-shadow authoring grammar (color keywords,
 * unitless `0`, etc.).
 *
 * Per the CSS grammar, `inset` and the color may each appear before or
 * after the length list — browsers aren't fully consistent about where —
 * so both are extracted independently (regex match + removal) rather
 * than assuming one fixed token order.
 *
 * A shadow entry with no color match is skipped rather than guessing a
 * color. This shouldn't happen from a real browser's computed style
 * (which always resolves `currentColor` to an explicit rgb()/rgba()) —
 * only from a hand-authored or malformed string.
 */
export function parseBoxShadow(raw: string | null | undefined): Effect[] {
  if (!raw || raw === "none") return [];
  const effects: Effect[] = [];
  for (const shadowText of splitTopLevel(raw)) {
    const effect = parseSingleShadow(shadowText);
    if (effect) effects.push(effect);
  }
  return effects;
}

function parseSingleShadow(text: string): Effect | null {
  let remaining = text.trim();

  const inset = /(^|\s)inset(\s|$)/.test(remaining);
  remaining = remaining.replace(/(^|\s)inset(\s|$)/, " ").trim();

  const colorMatch = COLOR_RE.exec(remaining);
  if (!colorMatch) return null;
  const color = parseColor(colorMatch[0]);
  if (!color?.parsed) return null;
  remaining = (remaining.slice(0, colorMatch.index) + remaining.slice(colorMatch.index + colorMatch[0].length)).trim();

  const lengths = remaining.match(LENGTH_RE)?.map((v) => Number.parseFloat(v));
  if (!lengths || lengths.length < 2) return null;
  const [offsetX, offsetY, blur = 0, spread] = lengths;

  return {
    type: inset ? "innerShadow" : "dropShadow",
    color: color.parsed,
    offsetX,
    offsetY,
    blur,
    spread,
  };
}