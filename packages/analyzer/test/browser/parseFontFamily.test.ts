import { describe, it, expect } from "vitest";
import { parseFontFamily } from "../../src/evidence/parseFontFamily.js";

describe("parseFontFamily", () => {
  it("returns null for null/undefined/empty input", () => {
    expect(parseFontFamily(null)).toBeNull();
    expect(parseFontFamily(undefined)).toBeNull();
    expect(parseFontFamily("")).toBeNull();
  });

  it("returns a bare single family name unchanged", () => {
    expect(parseFontFamily("Inter")).toBe("Inter");
  });

  it("picks the first specific name out of a full computed-style fallback stack", () => {
    expect(parseFontFamily('Inter, "Segoe UI", system-ui, sans-serif')).toBe("Inter");
  });

  it("strips double and single quotes from a multi-word family name", () => {
    expect(parseFontFamily('"Segoe UI", sans-serif')).toBe("Segoe UI");
    expect(parseFontFamily("'Segoe UI', sans-serif")).toBe("Segoe UI");
  });

  it("skips leading generic keywords to find the first specific name", () => {
    expect(parseFontFamily("system-ui, Roboto, sans-serif")).toBe("Roboto");
  });

  it("returns null when every entry is a generic keyword", () => {
    expect(parseFontFamily("system-ui, sans-serif")).toBeNull();
  });

  it("is case-insensitive when recognizing generic keywords, but preserves the case of the returned name", () => {
    expect(parseFontFamily("SANS-SERIF, Inter")).toBe("Inter");
  });

  it("tolerates irregular whitespace around commas", () => {
    expect(parseFontFamily('Inter ,  "Segoe UI"  ,sans-serif')).toBe("Inter");
  });
});
