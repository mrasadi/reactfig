import { describe, it, expect } from "vitest";
import { loadFontForText, mapFontStyle, mapTextAlign } from "../../src/code/render/typography.js";
import { createFakeFigma } from "../fakeFigma/createFakeFigma.js";
import type { RenderContext } from "../../src/code/render/types.js";

function makeCtx(unavailableFonts: string[] = []): { ctx: RenderContext; loadFontCalls: FontName[] } {
  const { figma, loadFontCalls } = createFakeFigma({ unavailableFonts });
  return { ctx: { figmaApi: figma, componentIndex: new Map(), assets: {}, assetMimeTypes: {}, warnings: [], loadedFonts: new Set() }, loadFontCalls };
}

describe("mapFontStyle", () => {
  it("maps weight buckets to Figma style names", () => {
    expect(mapFontStyle(400, false)).toBe("Regular");
    expect(mapFontStyle(700, false)).toBe("Bold");
    expect(mapFontStyle(600, false)).toBe("Semi Bold");
    expect(mapFontStyle(500, false)).toBe("Medium");
    expect(mapFontStyle(200, false)).toBe("Light");
  });

  it("appends Italic when requested", () => {
    expect(mapFontStyle(400, true)).toBe("Regular Italic");
    expect(mapFontStyle(700, true)).toBe("Bold Italic");
  });
});

describe("mapTextAlign", () => {
  it("maps all four alignment values, defaulting to LEFT", () => {
    expect(mapTextAlign("center")).toBe("CENTER");
    expect(mapTextAlign("right")).toBe("RIGHT");
    expect(mapTextAlign("justify")).toBe("JUSTIFIED");
    expect(mapTextAlign(undefined)).toBe("LEFT");
  });
});

describe("loadFontForText — availability and deterministic fallback", () => {
  it("loads and returns the desired font when available", async () => {
    const { ctx } = makeCtx();
    const resolved = await loadFontForText({ family: "Inter", style: "Bold" }, ctx);
    expect(resolved).toEqual({ family: "Inter", style: "Bold" });
    expect(ctx.warnings).toEqual([]);
  });

  it("falls back to Inter Regular and records a warning when the font is unavailable — never a random substitute", async () => {
    const { ctx } = makeCtx(["Custom Brand Font"]);
    const resolved = await loadFontForText({ family: "Custom Brand Font", style: "Bold" }, ctx);
    expect(resolved).toEqual({ family: "Inter", style: "Regular" });
    expect(ctx.warnings[0]).toMatch(/Custom Brand Font Bold.*not available.*falling back to Inter Regular/);
  });

  it("does not abort — a missing font produces exactly one warning, not a thrown error", async () => {
    const { ctx } = makeCtx(["Missing"]);
    await expect(loadFontForText({ family: "Missing", style: "Regular" }, ctx)).resolves.toBeDefined();
  });

  it("caches successful loads — does not call loadFontAsync again for the same font", async () => {
    const { ctx, loadFontCalls } = makeCtx();
    await loadFontForText({ family: "Inter", style: "Regular" }, ctx);
    await loadFontForText({ family: "Inter", style: "Regular" }, ctx);
    expect(loadFontCalls).toHaveLength(1);
  });
});
