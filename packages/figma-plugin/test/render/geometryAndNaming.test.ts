import { describe, it, expect } from "vitest";
import { relativePosition, safeSize, ZERO_BOUNDS } from "../../src/code/render/geometry.js";
import { variantNodeName, sanitizeVariantToken } from "../../src/code/render/naming.js";

describe("relativePosition — the coordinate-space correction (feasibility review, correction #1)", () => {
  it("computes a child's position relative to its parent by subtraction", () => {
    const parent = { x: 100, y: 50, width: 400, height: 300 };
    const child = { x: 120, y: 70, width: 50, height: 20 };
    expect(relativePosition(child, parent)).toEqual({ x: 20, y: 20 });
  });

  it("against ZERO_BOUNDS (top-level page content), position equals the node's own absolute bounds", () => {
    const child = { x: 40, y: 40, width: 160, height: 48 };
    expect(relativePosition(child, ZERO_BOUNDS)).toEqual({ x: 40, y: 40 });
  });
});

describe("safeSize", () => {
  it("clamps zero/negative dimensions to a minimal positive size", () => {
    expect(safeSize({ x: 0, y: 0, width: 0, height: -5 })).toEqual({ width: 0.01, height: 0.01 });
  });

  it("passes through normal positive dimensions unchanged", () => {
    expect(safeSize({ x: 0, y: 0, width: 160, height: 48 })).toEqual({ width: 160, height: 48 });
  });
});

describe("variant naming convention", () => {
  it("builds Figma's 'Property=Value, Property2=Value2' naming convention, in the declared axis order", () => {
    expect(variantNodeName({ variant: "primary", size: "large" }, ["variant", "size"])).toBe("variant=primary, size=large");
  });

  it("uses propertyOrder, not object key order — this is the fix for a real pack()/unpack() round-trip bug (object keys get alphabetically resorted by pack(), arrays don't)", () => {
    // propertyValues here is already in "wrong" (alphabetical) key order, as it would be after a pack()/unpack() round-trip.
    expect(variantNodeName({ size: "large", variant: "primary" }, ["variant", "size"])).toBe("variant=primary, size=large");
  });

  it("sanitizes commas and equals signs that would break Figma's parse", () => {
    expect(sanitizeVariantToken("a,b=c")).toBe("a-b-c");
    expect(variantNodeName({ label: "a,b" }, ["label"])).toBe("label=a-b");
  });
});
