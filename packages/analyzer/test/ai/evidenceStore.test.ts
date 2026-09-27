import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EvidenceStore } from "../../src/ai/evidenceStore.js";
import { executeGetEvidenceTool } from "../../src/ai/tools.js";
import { buildComponentEvidence } from "../../src/buildComponentEvidence.js";
import { inspectComponentSource } from "../../src/ast/inspectComponentSource.js";
import { interpretDomSnapshot } from "../../src/evidence/interpretDomSnapshot.js";
import type { RawDomSnapshot } from "../../src/browser/rawTypes.js";
import type { RenderCapture } from "../../src/evidence/types.js";

function fixturePath(rel: string): string {
  return fileURLToPath(new URL(`../fixtures/${rel}`, import.meta.url));
}
function loadRaw(name: string): RawDomSnapshot {
  return JSON.parse(readFileSync(fixturePath(`raw-snapshots/${name}.json`), "utf-8"));
}
function toCapture(label: string, raw: RawDomSnapshot, propValues?: Record<string, unknown>): RenderCapture {
  return {
    label,
    viewport: { width: 1440, height: 900 },
    propValues,
    dom: interpretDomSnapshot(raw),
    screenshot: { path: `/tmp/${label}.png`, width: 100, height: 100 },
    contextScreenshot: null,
    capturedUrl: "http://localhost:3000",
    capturedAt: "2026-08-19T12:00:00.000Z",
  };
}

function sessionCardEvidence() {
  const source = inspectComponentSource(fixturePath("react/SessionCard.tsx"));
  const captures = [toCapture("default", loadRaw("session-card"), { status: "completed" })];
  return buildComponentEvidence({ componentName: "SessionCard", source, captures, analyzerVersion: "test" });
}

describe("EvidenceStore", () => {
  const store = new EvidenceStore(sessionCardEvidence());

  it("getSource returns AST evidence", () => {
    expect(store.getSource().exportName).toBe("SessionCard");
  });

  it("listCaptures summarizes without full DOM detail", () => {
    const captures = store.listCaptures();
    expect(captures).toEqual([{ label: "default", viewportLabel: undefined, propValues: { status: "completed" }, rootLayoutMode: "block" }]);
  });

  it("getElementAtPath resolves a nested path", () => {
    const badge = store.getElementAtPath("default", [1, 1]); // card > row > badge
    expect(badge?.tag).toBe("span");
    expect(badge?.textContent).toBe("completed");
  });

  it("getElementAtPath returns null for a path beyond the tree", () => {
    expect(store.getElementAtPath("default", [99])).toBeNull();
  });

  it("getNestedComponentSummary finds Avatar without full recursive detail leaking into unrelated queries", () => {
    const summary = store.getNestedComponentSummary("Avatar");
    expect(summary).toHaveLength(1);
    expect(summary[0].tag).toBe("img");
    expect(summary[0].componentPath).toEqual(["SessionCard", "Avatar"]);
  });

  it("getAssetMetadata finds the avatar image by src", () => {
    const asset = store.getAssetMetadata("/avatars/amir.png");
    expect(asset).toEqual({ src: "/avatars/amir.png", naturalWidth: 256, naturalHeight: 256, alt: "Amir Hosseini", source: "img" });
  });

  it("getAssetMetadata returns null for an unknown src", () => {
    expect(store.getAssetMetadata("/nope.png")).toBeNull();
  });

  it("getScreenshotRef returns the primary screenshot by default", () => {
    expect(store.getScreenshotRef("default")).toEqual({ path: "/tmp/default.png", width: 100, height: 100 });
  });
});

describe("executeGetEvidenceTool", () => {
  const store = new EvidenceStore(sessionCardEvidence());

  it("kind=source returns AST evidence as JSON text", () => {
    const result = executeGetEvidenceTool(store, { kind: "source" });
    expect(JSON.parse(result.text).exportName).toBe("SessionCard");
  });

  it("kind=element requires captureLabel and path, errors clearly without them", () => {
    const result = executeGetEvidenceTool(store, { kind: "element" });
    expect(result.text).toMatch(/requires captureLabel and path/);
  });

  it("kind=nested_component returns a summary", () => {
    const result = executeGetEvidenceTool(store, { kind: "nested_component", componentName: "Badge" });
    const parsed = JSON.parse(result.text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].componentPath).toEqual(["SessionCard", "Badge"]);
  });

  it("kind=asset errors clearly for an unknown asset", () => {
    const result = executeGetEvidenceTool(store, { kind: "asset", assetRef: "/nope.png" });
    expect(result.text).toMatch(/no asset found/);
  });

  it("kind=screenshot returns an imagePath alongside text", () => {
    const result = executeGetEvidenceTool(store, { kind: "screenshot", captureLabel: "default" });
    expect(result.imagePath).toBe("/tmp/default.png");
    expect(result.text).toMatch(/100x100/);
  });

  it("unknown kind produces a clear error rather than throwing", () => {
    const result = executeGetEvidenceTool(store, { kind: "bogus" });
    expect(result.text).toMatch(/unknown evidence kind/);
  });
});
