import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateDesignIR, assertDesignIR } from "../src/validate.js";

function loadExample() {
  const path = fileURLToPath(new URL("../../../docs/design-ir/example.button.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("validateDesignIR", () => {
  it("accepts the reference example document", () => {
    const doc = loadExample();
    const result = validateDesignIR(doc);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("rejects a document missing required top-level fields", () => {
    const result = validateDesignIR({ version: "design-ir/v1" });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects an unknown node type", () => {
    const doc = loadExample();
    doc.pages[0].children.push({
      type: "sparkle",
      id: "bad",
      name: "bad",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
    });
    const result = validateDesignIR(doc);
    expect(result.valid).toBe(false);
  });

  it("rejects a color component out of 0-1 range", () => {
    const doc = loadExample();
    doc.components[0].variants[0].root.fills[0].color.r = 2.5;
    const result = validateDesignIR(doc);
    expect(result.valid).toBe(false);
  });

  it("rejects additional properties not in the schema", () => {
    const doc = loadExample();
    doc.pages[0].children[0].unexpectedField = true;
    const result = validateDesignIR(doc);
    expect(result.valid).toBe(false);
  });

  it("accepts a frame using CSS-grid fallback (absolute children, layout.mode 'none')", () => {
    const doc = loadExample();
    doc.pages[0].children.push({
      type: "frame",
      id: "node_grid_fallback",
      name: "GridFallback",
      bounds: { x: 0, y: 100, width: 300, height: 200 },
      layout: { mode: "none" },
      children: [
        {
          type: "shape",
          id: "node_grid_cell_1",
          name: "Cell 1",
          shape: "rectangle",
          bounds: { x: 0, y: 0, width: 140, height: 90 },
          fills: [{ type: "solid", color: { r: 0.9, g: 0.9, b: 0.9, a: 1 } }],
        },
      ],
    });
    const result = validateDesignIR(doc);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("assertDesignIR throws with a readable message for an invalid document", () => {
    expect(() => assertDesignIR({ nonsense: true })).toThrow(/Invalid design-ir\/v1 document/);
  });
});
