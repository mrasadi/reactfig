/// <reference types="@figma/plugin-typings" />
import type { Typography } from "@reactfig/core";
import type { RenderContext } from "./types.js";

const FALLBACK_FONT: FontName = { family: "Inter", style: "Regular" };

/** Coarse weight/style -> Figma style-name mapping. Figma's FontName.style is a free-form, font-family-specific string ("Regular", "Bold", "Semi Bold", "Medium Italic", ...) — there's no numeric-weight API, so this is inherently approximate for families with unusual style names. */
export function mapFontStyle(fontWeight: number, italic: boolean): string {
  const weightName =
    fontWeight >= 700 ? "Bold" : fontWeight >= 600 ? "Semi Bold" : fontWeight >= 500 ? "Medium" : fontWeight <= 300 ? "Light" : "Regular";
  return italic ? `${weightName} Italic` : weightName;
}

export function mapTextAlign(textAlign: Typography["textAlign"]): "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED" {
  switch (textAlign) {
    case "center":
      return "CENTER";
    case "right":
      return "RIGHT";
    case "justify":
      return "JUSTIFIED";
    default:
      return "LEFT";
  }
}

/**
 * Loads the desired font, falling back to Inter Regular (and recording a
 * warning) if it isn't available to the editor — per the brief, "missing
 * fonts should produce a warning and a deterministic fallback rather than
 * aborting the entire document," and "do not silently substitute a random
 * font." loadFontAsync only loads fonts already available to the Figma
 * editor; it does not fetch from the internet (verified — see
 * docs/figma-plugin/feasibility.md).
 */
export async function loadFontForText(desired: FontName, ctx: RenderContext): Promise<FontName> {
  const key = `${desired.family}::${desired.style}`;
  if (ctx.loadedFonts.has(key)) return desired;

  try {
    await ctx.figmaApi.loadFontAsync(desired);
    ctx.loadedFonts.add(key);
    return desired;
  } catch {
    ctx.warnings.push(`Font "${desired.family} ${desired.style}" is not available in this Figma file — falling back to Inter Regular.`);
    const fallbackKey = `${FALLBACK_FONT.family}::${FALLBACK_FONT.style}`;
    if (!ctx.loadedFonts.has(fallbackKey)) {
      await ctx.figmaApi.loadFontAsync(FALLBACK_FONT);
      ctx.loadedFonts.add(fallbackKey);
    }
    return FALLBACK_FONT;
  }
}

/**
 * Must be called AFTER loadFontForText resolves and text.fontName is set —
 * Figma requires the font loaded before any property that affects rendered
 * text — and after `text.characters` is set, since the auto-height
 * calculation below needs the actual text content already in place.
 *
 * `width` is the node's intended box width (from its IR `bounds`, same as
 * every other render* function in renderNode.ts sizes its node to). It only
 * actually gets applied when `textAlign` calls for it — see below.
 */
export function applyTypography(text: TextNode, typography: Typography, width: number): void {
  text.fontSize = typography.fontSize;
  if (typography.lineHeight !== undefined) {
    // IR's Typography.lineHeight is number (px) | {unit:"percent", value} — these map to
    // two different Figma LineHeight unit variants, not just one; treating the object form
    // as a plain number here would silently drop the percent semantics.
    text.lineHeight =
      typeof typography.lineHeight === "number"
        ? { unit: "PIXELS", value: typography.lineHeight }
        : { unit: "PERCENT", value: typography.lineHeight.value };
  }
  if (typography.letterSpacing !== undefined) text.letterSpacing = { unit: "PIXELS", value: typography.letterSpacing };
  text.textAlignHorizontal = mapTextAlign(typography.textAlign);

  // `textAlignHorizontal` only has any visible effect within a box wider
  // than the text itself — a hug-width box is, by definition, exactly as
  // wide as its own content, so center/right/justify alignment inside one
  // is a no-op (this is the "badge/pill text renders pinned to the top-left
  // instead of centered" bug: every text node used to hug both dimensions
  // unconditionally, discarding the IR's captured box width — and with it,
  // the only thing CENTER alignment could ever center within — regardless
  // of what the source's own text-align/flex-centering was).
  //
  // Left alignment (the default, and the common case: labels, paragraphs)
  // keeps hugging both width and height, matching a plain auto-sized text
  // layer — the previously-passing default and normal design-tool
  // convention for unconstrained text.
  if (typography.textAlign && typography.textAlign !== "left") {
    text.textAutoResize = "HEIGHT"; // fixed width, auto height — the only Figma mode that keeps a real box for alignment to work within
    text.resize(width, text.height);
  } else {
    // Approximate — see docs/figma-plugin/feasibility.md, "Typography: text wrapping": IR doesn't yet carry a wrap-mode signal.
    text.textAutoResize = "WIDTH_AND_HEIGHT";
  }
}
