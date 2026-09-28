import { describe, it, expect } from "vitest";
import { OUTPUT_FORMATS } from "@reactfig/artifact";
import { buildOverlayScript, OVERLAY_VERSION } from "../../src/collection/overlayScript.js";

// The overlay is injected into a real page, so its DOM behavior can only be
// exercised in a browser. These checks are the cheap, dependency-free ones:
// the emitted script must stay syntactically valid, and the Output Intent
// control must remain the custom settings-area select (not the native
// <select> that used to live in the per-selection preview).
describe("buildOverlayScript — output format select", () => {
  const script = buildOverlayScript();

  it("emits syntactically valid JavaScript", () => {
    expect(() => new Function(script)).not.toThrow();
  });

  it("does not use a browser-native <select>", () => {
    expect(script).not.toContain('createElement("select")');
  });

  it("renders the custom select inside the panel's settings area", () => {
    expect(script).toContain("buildOutputSelect");
    expect(script).toContain('"Output format"');
    expect(script).toContain('settings.appendChild(buildOutputSelect())');
  });

  it("offers exactly the pipeline's output formats", () => {
    const declared = [...script.matchAll(/\{ value: "(\w+)", label:/g)].map((m) => m[1]);
    expect(declared).toEqual([...OUTPUT_FORMATS]);
  });

  it("keeps the chosen format visible when minimized and in the preview", () => {
    expect(script).toContain('chip.className = "chip"');
    expect(script).toContain('"Output: " + currentOutputOption().label');
  });

  it("still sends the panel-selected format when a selection is confirmed", () => {
    expect(script).toContain("outputFormat: state.pendingOutputFormat");
  });

  it("is version-guarded so an older overlay left in a page can't mask this build", () => {
    expect(script).toContain(`var OVERLAY_VERSION = "${OVERLAY_VERSION}";`);
    expect(script).toContain("window.__reactfigOverlayInstalled === OVERLAY_VERSION");
    expect(script).not.toContain("window.__reactfigOverlayInstalled = true");
  });
});
