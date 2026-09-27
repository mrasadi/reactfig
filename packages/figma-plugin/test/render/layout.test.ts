import { describe, it, expect } from "vitest";
import { applyLayout } from "../../src/code/render/layout.js";
import type { Layout } from "@reactfig/core";

function fakeFrame(): Record<string, unknown> {
  return {};
}

describe("applyLayout — flex mapping", () => {
  it("maps horizontal flex with gap, padding, and start/center alignment", () => {
    const frame = fakeFrame();
    const layout: Layout = {
      mode: "horizontal",
      gap: 8,
      padding: { top: 12, right: 24, bottom: 12, left: 24 },
      primaryAxisAlign: "center",
      counterAxisAlign: "center",
    };
    const result = applyLayout(frame as never, layout);
    expect(frame).toMatchObject({
      layoutMode: "HORIZONTAL",
      primaryAxisSizingMode: "FIXED",
      counterAxisSizingMode: "FIXED",
      itemSpacing: 8,
      paddingTop: 12,
      paddingRight: 24,
      paddingBottom: 12,
      paddingLeft: 24,
      primaryAxisAlignItems: "CENTER",
      counterAxisAlignItems: "CENTER",
    });
    expect(result.stretchChildren).toBe(false);
  });

  it("maps vertical direction and spaceBetween", () => {
    const frame = fakeFrame();
    applyLayout(frame as never, { mode: "vertical", primaryAxisAlign: "spaceBetween", counterAxisAlign: "end" });
    expect(frame).toMatchObject({ layoutMode: "VERTICAL", primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "MAX" });
  });

  it("maps wrap", () => {
    const frame = fakeFrame();
    applyLayout(frame as never, { mode: "horizontal", wrap: true });
    expect(frame).toMatchObject({ layoutWrap: "WRAP" });
  });
});

describe("applyLayout — sizing mode (the 'Header renders narrower than full width' fix)", () => {
  it("sets primaryAxisSizingMode and counterAxisSizingMode to FIXED for any flex frame, not just when stretch is requested — bounds are always a real measured size, never a hug hint", () => {
    const frame = fakeFrame();
    applyLayout(frame as never, { mode: "horizontal", primaryAxisAlign: "spaceBetween", counterAxisAlign: "center" });
    expect((frame as Record<string, unknown>).primaryAxisSizingMode).toBe("FIXED");
    expect((frame as Record<string, unknown>).counterAxisSizingMode).toBe("FIXED");
  });

  it("still sets counterAxisSizingMode:'FIXED' when stretch is requested (subsumed by the unconditional FIXED above, kept as an explicit regression check)", () => {
    const frame = fakeFrame();
    applyLayout(frame as never, { mode: "horizontal", counterAxisAlign: "stretch" });
    expect((frame as Record<string, unknown>).counterAxisSizingMode).toBe("FIXED");
  });
});

describe("applyLayout — layout.mode:'none' (absolute / CSS Grid fallback)", () => {
  it("sets layoutMode:'NONE' and does not touch Auto Layout properties", () => {
    const frame = fakeFrame();
    const result = applyLayout(frame as never, { mode: "none" });
    expect(frame).toEqual({ layoutMode: "NONE" });
    expect(result.stretchChildren).toBe(false);
  });

  it("treats an absent layout the same as layout.mode:'none'", () => {
    const frame = fakeFrame();
    applyLayout(frame as never, undefined);
    expect((frame as Record<string, unknown>).layoutMode).toBe("NONE");
  });
});
