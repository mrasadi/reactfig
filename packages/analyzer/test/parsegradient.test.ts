import { describe, it, expect } from "vitest";
import { parseLinearGradient, parseRadialGradient, parseConicGradient } from "../src/evidence/parseGradient.js";

describe("parseLinearGradient", () => {
  it("returns null for none/empty/plain solid-color input", () => {
    expect(parseLinearGradient(null)).toBeNull();
    expect(parseLinearGradient(undefined)).toBeNull();
    expect(parseLinearGradient("none")).toBeNull();
  });

  it("returns null for radial-gradient and conic-gradient (no Fill shape for either in design-ir/v1)", () => {
    expect(parseLinearGradient("radial-gradient(circle, rgb(255, 0, 0), rgb(0, 0, 255))")).toBeNull();
    expect(parseLinearGradient("conic-gradient(rgb(255, 0, 0), rgb(0, 0, 255))")).toBeNull();
  });

  it("returns null for repeating-linear-gradient (no repeat concept in the schema)", () => {
    expect(parseLinearGradient("repeating-linear-gradient(90deg, rgb(255, 0, 0), rgb(0, 0, 255) 10px)")).toBeNull();
  });

  it("only considers the first background layer when multiple are comma-separated", () => {
    // First layer is a plain url(), not a gradient at all -> null, even
    // though a gradient exists later in the string.
    expect(parseLinearGradient('url("photo.jpg"), linear-gradient(rgb(255, 0, 0), rgb(0, 0, 255))')).toBeNull();
  });

  describe("angle conversion (CSS convention: 0=to top, clockwise -> design-ir: 0=pointing right, clockwise)", () => {
    // 'to right' visually points right -> design-ir angleDeg 0 (its own zero-point).
    it("'to right' -> angleDeg 0", () => {
      const fill = parseLinearGradient("linear-gradient(to right, rgb(255, 0, 0), rgb(0, 0, 255))");
      expect(fill).toMatchObject({ angleDeg: 0 });
    });

    // CSS default direction (no angle/side given) is 'to bottom' = top-to-bottom,
    // which is design-ir angleDeg 90 (derived from angleToGradientTransform's
    // own matrix — see parseGradient.ts's doc comment).
    it("no direction given defaults to CSS's 'to bottom' -> angleDeg 90", () => {
      const fill = parseLinearGradient("linear-gradient(rgb(255, 0, 0), rgb(0, 0, 255))");
      expect(fill).toMatchObject({ angleDeg: 90 });
    });

    it("'to bottom' (explicit) -> angleDeg 90, same as the default", () => {
      const fill = parseLinearGradient("linear-gradient(to bottom, rgb(255, 0, 0), rgb(0, 0, 255))");
      expect(fill).toMatchObject({ angleDeg: 90 });
    });

    it("'to top' -> angleDeg 270", () => {
      const fill = parseLinearGradient("linear-gradient(to top, rgb(255, 0, 0), rgb(0, 0, 255))");
      expect(fill).toMatchObject({ angleDeg: 270 });
    });

    it("'to left' -> angleDeg 180", () => {
      const fill = parseLinearGradient("linear-gradient(to left, rgb(255, 0, 0), rgb(0, 0, 255))");
      expect(fill).toMatchObject({ angleDeg: 180 });
    });

    it("explicit '90deg' (CSS convention, = 'to right') -> angleDeg 0", () => {
      const fill = parseLinearGradient("linear-gradient(90deg, rgb(255, 0, 0), rgb(0, 0, 255))");
      expect(fill).toMatchObject({ angleDeg: 0 });
    });

    it("explicit '45deg' converts with the same -90 offset, wrapping into [0, 360)", () => {
      const fill = parseLinearGradient("linear-gradient(45deg, rgb(255, 0, 0), rgb(0, 0, 255))");
      expect(fill).toMatchObject({ angleDeg: 315 });
    });

    it("a square box's 'to top right' is exactly 45° in CSS convention -> angleDeg 315 after the -90 shift", () => {
      const fill = parseLinearGradient("linear-gradient(to top right, rgb(255, 0, 0), rgb(0, 0, 255))", { width: 100, height: 100 });
      expect(fill).toMatchObject({ angleDeg: 315 });
    });

    it("a non-square box's corner angle depends on aspect ratio (wider box tilts the corner angle toward horizontal)", () => {
      const wide = parseLinearGradient("linear-gradient(to top right, rgb(255, 0, 0), rgb(0, 0, 255))", { width: 200, height: 100 });
      const square = parseLinearGradient("linear-gradient(to top right, rgb(255, 0, 0), rgb(0, 0, 255))", { width: 100, height: 100 });
      expect((wide as { angleDeg: number }).angleDeg).not.toBe((square as { angleDeg: number }).angleDeg);
    });

    it("falls back to a fixed 45°-multiple for a corner when no boxSize is supplied", () => {
      const fill = parseLinearGradient("linear-gradient(to bottom left, rgb(255, 0, 0), rgb(0, 0, 255))");
      expect(fill).toMatchObject({ angleDeg: 135 });
    });
  });

  describe("color stops", () => {
    it("two unpositioned stops default to 0% and 100%", () => {
      const fill = parseLinearGradient("linear-gradient(to right, rgb(255, 0, 0), rgb(0, 0, 255))");
      expect(fill).toMatchObject({
        stops: [
          { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
          { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
        ],
      });
    });

    it("respects explicit percentage positions", () => {
      const fill = parseLinearGradient("linear-gradient(to right, rgb(255, 0, 0) 20%, rgb(0, 0, 255) 80%)");
      expect(fill).toMatchObject({ stops: [{ position: 0.2 }, { position: 0.8 }] });
    });

    it("evenly distributes an unpositioned middle stop between its positioned neighbors", () => {
      const fill = parseLinearGradient(
        "linear-gradient(to right, rgb(255, 0, 0) 0%, rgb(0, 255, 0), rgb(0, 0, 255) 100%)"
      );
      expect(fill).toMatchObject({ stops: [{ position: 0 }, { position: 0.5 }, { position: 1 }] });
    });

    it("evenly distributes multiple consecutive unpositioned stops between their neighbors", () => {
      const fill = parseLinearGradient(
        "linear-gradient(to right, rgb(255, 0, 0) 0%, rgb(0, 255, 0), rgb(0, 255, 255), rgb(0, 0, 255) 90%)"
      );
      const positions = (fill as { stops: { position: number }[] }).stops.map((s) => Math.round(s.position * 100) / 100);
      expect(positions).toEqual([0, 0.3, 0.6, 0.9]);
    });

    it("clamps a position that would regress before the previous stop's position", () => {
      const fill = parseLinearGradient("linear-gradient(to right, rgb(255, 0, 0) 50%, rgb(0, 0, 255) 20%)");
      const positions = (fill as { stops: { position: number }[] }).stops.map((s) => s.position);
      expect(positions).toEqual([0.5, 0.5]);
    });

    it("returns null (not a partial gradient) for fewer than 2 resolvable stops", () => {
      expect(parseLinearGradient("linear-gradient(to right, rgb(255, 0, 0))")).toBeNull();
    });

    it("returns null (not a partial gradient) when a stop's color is unparseable", () => {
      expect(parseLinearGradient("linear-gradient(to right, red, rgb(0, 0, 255))")).toBeNull();
    });
  });
});
describe("parseRadialGradient", () => {
  it("returns null for none/empty/plain solid-color input, and for linear-gradient/conic-gradient", () => {
    expect(parseRadialGradient(null)).toBeNull();
    expect(parseRadialGradient(undefined)).toBeNull();
    expect(parseRadialGradient("none")).toBeNull();
    expect(parseRadialGradient("linear-gradient(90deg, rgb(255, 0, 0), rgb(0, 0, 255))")).toBeNull();
    expect(parseRadialGradient("conic-gradient(rgb(255, 0, 0), rgb(0, 0, 255))")).toBeNull();
  });

  it("returns null for repeating-radial-gradient (no repeat concept in the schema)", () => {
    expect(parseRadialGradient("repeating-radial-gradient(circle, rgb(255, 0, 0), rgb(0, 0, 255) 10px)")).toBeNull();
  });

  it("defaults to a centered gradient (0.5, 0.5) with no shape/position argument at all", () => {
    const fill = parseRadialGradient("radial-gradient(rgb(255, 0, 0), rgb(0, 0, 255))");
    expect(fill).toMatchObject({ type: "radialGradient", centerX: 0.5, centerY: 0.5 });
  });

  it("defaults to centered when only a shape keyword is given, no 'at' clause", () => {
    const fill = parseRadialGradient("radial-gradient(circle, rgb(255, 0, 0), rgb(0, 0, 255))");
    expect(fill).toMatchObject({ centerX: 0.5, centerY: 0.5 });
  });

  it("extracts an explicit 'at X% Y%' position", () => {
    const fill = parseRadialGradient("radial-gradient(circle at 20% 80%, rgb(255, 0, 0), rgb(0, 0, 255))");
    expect(fill).toMatchObject({ centerX: 0.2, centerY: 0.8 });
  });

  it("extracts 'at center' as (0.5, 0.5)", () => {
    const fill = parseRadialGradient("radial-gradient(ellipse at center, rgb(255, 0, 0), rgb(0, 0, 255))");
    expect(fill).toMatchObject({ centerX: 0.5, centerY: 0.5 });
  });

  it("parses color stops the same way parseLinearGradient does (shared parseColorStops)", () => {
    const fill = parseRadialGradient("radial-gradient(circle at 50% 50%, rgb(255, 0, 0) 10%, rgb(0, 0, 255) 90%)");
    expect(fill).toEqual({
      type: "radialGradient",
      centerX: 0.5,
      centerY: 0.5,
      stops: [
        { position: 0.1, color: { r: 1, g: 0, b: 0, a: 1 } },
        { position: 0.9, color: { r: 0, g: 0, b: 1, a: 1 } },
      ],
    });
  });

  it("returns null for fewer than 2 resolvable stops", () => {
    expect(parseRadialGradient("radial-gradient(circle, rgb(255, 0, 0))")).toBeNull();
  });

  it("only considers the first background layer when multiple are comma-separated", () => {
    const fill = parseRadialGradient('radial-gradient(circle at 10% 10%, rgb(255, 0, 0), rgb(0, 0, 255)), url("photo.png")');
    expect(fill).toMatchObject({ centerX: 0.1, centerY: 0.1 });
  });
});

describe("parseConicGradient", () => {
  it("returns null for none/empty/plain solid-color input, and for linear-gradient/radial-gradient", () => {
    expect(parseConicGradient(null)).toBeNull();
    expect(parseConicGradient(undefined)).toBeNull();
    expect(parseConicGradient("none")).toBeNull();
    expect(parseConicGradient("linear-gradient(90deg, rgb(255, 0, 0), rgb(0, 0, 255))")).toBeNull();
    expect(parseConicGradient("radial-gradient(circle, rgb(255, 0, 0), rgb(0, 0, 255))")).toBeNull();
  });

  it("returns null for repeating-conic-gradient (no repeat concept in the schema)", () => {
    expect(parseConicGradient("repeating-conic-gradient(rgb(255, 0, 0), rgb(0, 0, 255) 30deg)")).toBeNull();
  });

  it("defaults to a centered gradient starting at 0deg with no 'from'/'at' clause at all", () => {
    const fill = parseConicGradient("conic-gradient(rgb(255, 0, 0), rgb(0, 0, 255))");
    expect(fill).toMatchObject({ type: "conicGradient", centerX: 0.5, centerY: 0.5, startAngleDeg: 0 });
  });

  it("extracts an explicit 'from <angle>' in degrees", () => {
    const fill = parseConicGradient("conic-gradient(from 45deg, rgb(255, 0, 0), rgb(0, 0, 255))");
    expect(fill).toMatchObject({ startAngleDeg: 45, centerX: 0.5, centerY: 0.5 });
  });

  it("normalizes 'from <angle>' in turn/rad/grad units to degrees", () => {
    expect(parseConicGradient("conic-gradient(from 0.25turn, rgb(255, 0, 0), rgb(0, 0, 255))")).toMatchObject({ startAngleDeg: 90 });
    expect(parseConicGradient(`conic-gradient(from ${Math.PI / 2}rad, rgb(255, 0, 0), rgb(0, 0, 255))`)).toMatchObject({ startAngleDeg: expect.closeTo(90, 5) });
    expect(parseConicGradient("conic-gradient(from 100grad, rgb(255, 0, 0), rgb(0, 0, 255))")).toMatchObject({ startAngleDeg: 90 });
  });

  it("extracts both 'from <angle>' and 'at X% Y%' together", () => {
    const fill = parseConicGradient("conic-gradient(from 45deg at 30% 70%, rgb(255, 0, 0), rgb(0, 0, 255))");
    expect(fill).toMatchObject({ startAngleDeg: 45, centerX: 0.3, centerY: 0.7 });
  });

  it("extracts 'at' alone (no 'from') — startAngleDeg stays 0", () => {
    const fill = parseConicGradient("conic-gradient(at 20% 80%, rgb(255, 0, 0), rgb(0, 0, 255))");
    expect(fill).toMatchObject({ startAngleDeg: 0, centerX: 0.2, centerY: 0.8 });
  });

  it("parses color stops the same way the other gradient functions do (shared parseColorStops)", () => {
    const fill = parseConicGradient("conic-gradient(rgb(255, 0, 0) 25%, rgb(0, 0, 255) 75%)");
    expect(fill).toEqual({
      type: "conicGradient",
      centerX: 0.5,
      centerY: 0.5,
      startAngleDeg: 0,
      stops: [
        { position: 0.25, color: { r: 1, g: 0, b: 0, a: 1 } },
        { position: 0.75, color: { r: 0, g: 0, b: 1, a: 1 } },
      ],
    });
  });

  it("returns null for fewer than 2 resolvable stops", () => {
    expect(parseConicGradient("conic-gradient(rgb(255, 0, 0))")).toBeNull();
  });

  it("only considers the first background layer when multiple are comma-separated", () => {
    const fill = parseConicGradient('conic-gradient(from 10deg, rgb(255, 0, 0), rgb(0, 0, 255)), url("photo.png")');
    expect(fill).toMatchObject({ startAngleDeg: 10 });
  });
});
