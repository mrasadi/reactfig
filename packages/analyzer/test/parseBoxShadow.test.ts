import { describe, it, expect } from "vitest";
import { parseBoxShadow } from "../src/evidence/parseBoxShadow.js";

describe("parseBoxShadow", () => {
  it("returns [] for 'none' or empty input", () => {
    expect(parseBoxShadow("none")).toEqual([]);
    expect(parseBoxShadow(null)).toEqual([]);
    expect(parseBoxShadow(undefined)).toEqual([]);
    expect(parseBoxShadow("")).toEqual([]);
  });

  it("parses a single dropShadow with color-first ordering (Chromium's typical serialization)", () => {
    const effects = parseBoxShadow("rgba(0, 0, 0, 0.15) 0px 1px 2px 0px");
    expect(effects).toEqual([{ type: "dropShadow", color: { r: 0, g: 0, b: 0, a: 0.15 }, offsetX: 0, offsetY: 1, blur: 2, spread: 0 }]);
  });

  it("parses offsetX/offsetY/blur without an explicit spread (3-length form) as spread: undefined", () => {
    const effects = parseBoxShadow("rgb(0, 0, 0) 2px 4px 6px");
    expect(effects[0]).toEqual({ type: "dropShadow", color: { r: 0, g: 0, b: 0, a: 1 }, offsetX: 2, offsetY: 4, blur: 6, spread: undefined });
  });

  it("negative offsets and negative spread (common in layered Tailwind-style shadows)", () => {
    const effects = parseBoxShadow("rgba(0, 0, 0, 0.1) 0px 4px 6px -1px");
    expect(effects[0]).toMatchObject({ offsetX: 0, offsetY: 4, blur: 6, spread: -1 });
  });

  it("recognizes 'inset' regardless of whether it's placed before or after the rest", () => {
    const before = parseBoxShadow("inset rgb(0, 0, 0) 0px 0px 0px 1px");
    const after = parseBoxShadow("rgb(0, 0, 0) 0px 0px 0px 1px inset");
    expect(before[0].type).toBe("innerShadow");
    expect(after[0].type).toBe("innerShadow");
  });

  it("parses multiple comma-separated shadows (does not split on the commas inside rgba(...))", () => {
    const effects = parseBoxShadow("rgba(0, 0, 0, 0.1) 0px 4px 6px -1px, rgba(0, 0, 0, 0.06) 0px 2px 4px -1px");
    expect(effects).toHaveLength(2);
    expect(effects[0]).toMatchObject({ offsetY: 4, blur: 6 });
    expect(effects[1]).toMatchObject({ offsetY: 2, blur: 4 });
  });

  it("a mix of inset and non-inset shadows in one list resolves each independently", () => {
    const effects = parseBoxShadow("inset 0px 1px 0px rgb(255, 255, 255), rgba(0, 0, 0, 0.2) 0px 2px 4px");
    expect(effects.map((e) => e.type)).toEqual(["innerShadow", "dropShadow"]);
  });

  it("skips (rather than fabricates a color for) a malformed shadow entry with no color", () => {
    expect(parseBoxShadow("0px 1px 2px")).toEqual([]);
  });

  it("skips an entry with fewer than 2 length values even if a color is present", () => {
    expect(parseBoxShadow("rgb(0, 0, 0) 4px")).toEqual([]);
  });
});