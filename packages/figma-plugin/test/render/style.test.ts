import { describe, it, expect } from "vitest";
import { applyFills, applyStrokes, applyCornerRadius, applyEffects, buildFill } from "../../src/code/render/style.js";
import { createFakeFigma } from "../fakeFigma/createFakeFigma.js";
import type { RenderContext } from "../../src/code/render/types.js";
import type { Fill } from "@reactfig/core";

function makeCtx(): RenderContext {
  const { figma } = createFakeFigma();
  return { figmaApi: figma, componentIndex: new Map(), assets: {}, assetMimeTypes: {}, warnings: [], loadedFonts: new Set() };
}

describe("buildFill — solid", () => {
  it("maps a solid color fill with alpha as opacity", () => {
    const ctx = makeCtx();
    const fill: Fill = { type: "solid", color: { r: 0.1, g: 0.2, b: 0.3, a: 0.5 } };
    const paint = buildFill(fill, ctx, "test");
    expect(paint).toEqual({ type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.3 }, opacity: 0.5 });
  });

  it("returns null and warns for an unresolvable token color (no token system in v1)", () => {
    const ctx = makeCtx();
    const fill: Fill = { type: "solid", color: { token: "color.brand.primary" } };
    const paint = buildFill(fill, ctx, "Button root");
    expect(paint).toBeNull();
    expect(ctx.warnings[0]).toMatch(/token "color.brand.primary"/);
  });
});

describe("buildFill — linearGradient", () => {
  it("maps stops and computes a gradient transform from the angle", () => {
    const ctx = makeCtx();
    const fill: Fill = {
      type: "linearGradient",
      angleDeg: 90,
      stops: [
        { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
        { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
      ],
    };
    const paint = buildFill(fill, ctx, "test") as { type: string; gradientStops: unknown[]; gradientTransform: number[][] };
    expect(paint.type).toBe("GRADIENT_LINEAR");
    expect(paint.gradientStops).toHaveLength(2);
    expect(paint.gradientTransform).toHaveLength(2);
  });
});

describe("buildFill — radialGradient", () => {
  it("maps stops and computes a translation-only gradient transform from the center position", () => {
    const ctx = makeCtx();
    const fill: Fill = {
      type: "radialGradient",
      centerX: 0.5,
      centerY: 0.5,
      stops: [
        { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
        { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
      ],
    };
    const paint = buildFill(fill, ctx, "test") as { type: string; gradientStops: unknown[]; gradientTransform: number[][] };
    expect(paint.type).toBe("GRADIENT_RADIAL");
    expect(paint.gradientStops).toHaveLength(2);
    // Centered (0.5, 0.5) is the untransformed default — identity-like translation.
    expect(paint.gradientTransform).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
  });

  it("offsets the transform for an off-center gradient", () => {
    const ctx = makeCtx();
    const fill: Fill = {
      type: "radialGradient",
      centerX: 0.2,
      centerY: 0.8,
      stops: [
        { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
        { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
      ],
    };
    const paint = buildFill(fill, ctx, "test") as { type: string; gradientTransform: number[][] };
    expect(paint.gradientTransform[0][0]).toBe(1);
    expect(paint.gradientTransform[0][2]).toBeCloseTo(-0.3);
    expect(paint.gradientTransform[1][1]).toBe(1);
    expect(paint.gradientTransform[1][2]).toBeCloseTo(0.3);
  });
});

describe("buildFill — conicGradient", () => {
  it("maps to GRADIENT_ANGULAR with stops and a transform", () => {
    const ctx = makeCtx();
    const fill: Fill = {
      type: "conicGradient",
      centerX: 0.5,
      centerY: 0.5,
      startAngleDeg: 0,
      stops: [
        { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
        { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
      ],
    };
    const paint = buildFill(fill, ctx, "test") as { type: string; gradientStops: unknown[]; gradientTransform: number[][] };
    expect(paint.type).toBe("GRADIENT_ANGULAR");
    expect(paint.gradientStops).toHaveLength(2);
    // Centered, no rotation — identity-like transform.
    expect(paint.gradientTransform[0][0]).toBeCloseTo(1);
    expect(paint.gradientTransform[0][2]).toBeCloseTo(0);
  });

  it("rotates the transform for a non-zero start angle", () => {
    const ctx = makeCtx();
    const fill: Fill = {
      type: "conicGradient",
      centerX: 0.5,
      centerY: 0.5,
      startAngleDeg: 90,
      stops: [
        { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
        { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
      ],
    };
    const paint = buildFill(fill, ctx, "test") as { type: string; gradientTransform: number[][] };
    // 90° rotation: cos(90)=0, sin(90)=1
    expect(paint.gradientTransform[0][0]).toBeCloseTo(0);
    expect(paint.gradientTransform[1][0]).toBeCloseTo(1);
  });
});

describe("applyFills", () => {
  it("sets node.fills only for successfully-built paints, skipping unresolvable ones", () => {
    const ctx = makeCtx();
    const node = { fills: [] as unknown[] };
    applyFills(
      node,
      [
        { type: "solid", color: { r: 1, g: 1, b: 1, a: 1 } },
        { type: "solid", color: { token: "x" } },
      ],
      ctx,
      "test"
    );
    expect(node.fills).toHaveLength(1);
  });

  it("does nothing when fills is undefined", () => {
    const ctx = makeCtx();
    const node = { fills: ["untouched"] };
    applyFills(node, undefined, ctx, "test");
    expect(node.fills).toEqual(["untouched"]);
  });
});

describe("applyStrokes", () => {
  it("maps color, uses the max width across multiple strokes, and sets a dash pattern for dashed style", () => {
    const ctx = makeCtx();
    const node = { strokes: [] as unknown[], strokeWeight: 0, dashPattern: [] as number[] };
    applyStrokes(
      node,
      [
        { color: { r: 0, g: 0, b: 0, a: 1 }, width: 1 },
        { color: { r: 1, g: 1, b: 1, a: 1 }, width: 2, style: "dashed" },
      ],
      ctx,
      "test"
    );
    expect(node.strokeWeight).toBe(2);
    expect(node.dashPattern).toEqual([4, 4]);
    expect(node.strokes).toHaveLength(2);
  });

  // Regression tests for: a StatCard-style border-left accent stripe
  // (uniform 1px border + a distinct 4px left edge) rendering as if there
  // were no border at all, or as a plain uniform one with the accent lost.
  it("applies per-side stroke weights when the node supports individualStrokeWeights and strokeWeights is given", () => {
    const ctx = makeCtx();
    const node = {
      strokes: [] as unknown[],
      strokeWeight: 0,
      dashPattern: [] as number[],
      strokeTopWeight: 0,
      strokeRightWeight: 0,
      strokeBottomWeight: 0,
      strokeLeftWeight: 0,
    };
    applyStrokes(node, [{ color: { r: 0, g: 0.6, b: 0, a: 1 }, width: 4 }], ctx, "StatCard", { top: 1, right: 1, bottom: 1, left: 4 });
    expect(node.strokeTopWeight).toBe(1);
    expect(node.strokeRightWeight).toBe(1);
    expect(node.strokeBottomWeight).toBe(1);
    expect(node.strokeLeftWeight).toBe(4);
  });

  it("does not touch per-side weight fields when strokeWeights is not given (the common uniform-border case, unchanged)", () => {
    const ctx = makeCtx();
    const node = {
      strokes: [] as unknown[],
      strokeWeight: 0,
      dashPattern: [] as number[],
      strokeTopWeight: 0,
      strokeRightWeight: 0,
      strokeBottomWeight: 0,
      strokeLeftWeight: 0,
    };
    applyStrokes(node, [{ color: { r: 0, g: 0, b: 0, a: 1 }, width: 2 }], ctx, "test");
    expect(node.strokeTopWeight).toBe(0);
    expect(node.strokeWeight).toBe(2); // the uniform path still works exactly as before
  });

  it("does not throw when strokeWeights is given but the node type doesn't support individual stroke weights", () => {
    const ctx = makeCtx();
    const node = { strokes: [] as unknown[], strokeWeight: 0, dashPattern: [] as number[] }; // no strokeTopWeight etc. — e.g. a plain shape node
    expect(() => applyStrokes(node, [{ color: { r: 0, g: 0, b: 0, a: 1 }, width: 2 }], ctx, "test", { top: 1, right: 1, bottom: 1, left: 4 })).not.toThrow();
    expect(node.strokeWeight).toBe(2);
  });
});

describe("applyCornerRadius", () => {
  it("maps a uniform number to cornerRadius", () => {
    const node: Record<string, number> = {};
    applyCornerRadius(node, 8);
    expect(node.cornerRadius).toBe(8);
  });

  it("maps a 4-tuple to the four individual corner fields, in CSS order", () => {
    const node: Record<string, number> = {};
    applyCornerRadius(node, [1, 2, 3, 4]);
    expect(node).toEqual({ topLeftRadius: 1, topRightRadius: 2, bottomRightRadius: 3, bottomLeftRadius: 4 });
  });

  it("does nothing when cornerRadius is undefined", () => {
    const node: Record<string, number> = {};
    applyCornerRadius(node, undefined);
    expect(node).toEqual({});
  });
});

describe("applyEffects", () => {
  it("maps dropShadow with all fields, defaulting spread to 0", () => {
    const node = { effects: [] as unknown[] };
    applyEffects(node, [{ type: "dropShadow", color: { r: 0, g: 0, b: 0, a: 0.15 }, offsetX: 0, offsetY: 1, blur: 2 }]);
    expect(node.effects).toEqual([
      { type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.15 }, offset: { x: 0, y: 1 }, radius: 2, spread: 0, visible: true, blendMode: "NORMAL" },
    ]);
  });

  it("maps layerBlur", () => {
    const node = { effects: [] as unknown[] };
    applyEffects(node, [{ type: "layerBlur", radius: 4 }]);
    expect(node.effects).toEqual([{ type: "LAYER_BLUR", radius: 4, visible: true }]);
  });
});
