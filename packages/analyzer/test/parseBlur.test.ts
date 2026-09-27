import { describe, it, expect } from "vitest";
import { parseBlur } from "../src/evidence/parseBlur.js";

describe("parseBlur", () => {
  it("returns null for 'none' or empty input", () => {
    expect(parseBlur("none", "filter")).toBeNull();
    expect(parseBlur(null, "filter")).toBeNull();
    expect(parseBlur(undefined, "filter")).toBeNull();
    expect(parseBlur("", "backdrop-filter")).toBeNull();
  });

  it("maps a plain blur() filter to a layerBlur effect", () => {
    expect(parseBlur("blur(4px)", "filter")).toEqual({ type: "layerBlur", radius: 4 });
  });

  it("maps a plain blur() backdrop-filter to a backgroundBlur effect", () => {
    expect(parseBlur("blur(12px)", "backdrop-filter")).toEqual({ type: "backgroundBlur", radius: 12 });
  });

  it("extracts blur() from a chain of filter functions — the other functions aren't representable and are silently not included, but the blur itself still is", () => {
    expect(parseBlur("blur(4px) brightness(1.1)", "filter")).toEqual({ type: "layerBlur", radius: 4 });
    expect(parseBlur("contrast(0.9) blur(8px) grayscale(0.2)", "filter")).toEqual({ type: "layerBlur", radius: 8 });
  });

  it("returns null for a filter chain with no blur() at all", () => {
    expect(parseBlur("brightness(1.1) contrast(0.9)", "filter")).toBeNull();
  });

  it("returns null for a zero or negative radius (nothing meaningful to render)", () => {
    expect(parseBlur("blur(0px)", "filter")).toBeNull();
  });
});
