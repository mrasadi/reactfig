import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildInitialBundle } from "../../src/ai/evidenceBundle.js";
import { EvidenceStore } from "../../src/ai/evidenceStore.js";
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
function toCapture(label: string, raw: RawDomSnapshot, opts: Partial<RenderCapture> = {}): RenderCapture {
  return {
    label,
    viewport: { width: 1440, height: 900 },
    dom: interpretDomSnapshot(raw),
    screenshot: { path: `/tmp/${label}.png`, width: 320, height: 220 },
    contextScreenshot: null,
    capturedUrl: "http://localhost:3000",
    capturedAt: "2026-08-19T12:00:00.000Z",
    ...opts,
  };
}

describe("buildInitialBundle — pruning at nested-component boundaries", () => {
  it("collapses the Avatar/Badge subtrees instead of dumping their full recursive detail", () => {
    const source = inspectComponentSource(fixturePath("react/SessionCard.tsx"));
    const captures = [toCapture("default", loadRaw("session-card"))];
    const evidence = buildComponentEvidence({ componentName: "SessionCard", source, captures, analyzerVersion: "test" });
    const store = new EvidenceStore(evidence);

    const bundle = buildInitialBundle(evidence, store);

    // The full-detail region (SessionCard's own content) is present — the grid row itself
    // (session-card-row) is inside the target component's own boundary, so its layout mode
    // is visible even though the pruner doesn't echo className...
    expect(bundle.text).toContain('"layoutMode":"grid"');
    // ...but the nested Avatar/Badge subtrees are collapsed, not fully expanded:
    // their distinguishing style fields (e.g. the badge's specific font-size) should NOT appear.
    expect(bundle.text).not.toContain("badge-success");
    expect(bundle.text).toContain('"collapsed":true');
    expect(bundle.text).toContain("Avatar");
    expect(bundle.text).toContain("Badge");
  });

  it("includes the primary screenshot path for vision-capable use, when a screenshot exists", () => {
    const source = inspectComponentSource(fixturePath("react/SessionCard.tsx"));
    const captures = [toCapture("default", loadRaw("session-card"))];
    const evidence = buildComponentEvidence({ componentName: "SessionCard", source, captures, analyzerVersion: "test" });
    const bundle = buildInitialBundle(evidence, new EvidenceStore(evidence));
    expect(bundle.primaryScreenshotPath).toBe("/tmp/default.png");
  });

  it("flags a layout-mode difference across captures without attaching extra screenshots", () => {
    const source = inspectComponentSource(fixturePath("react/SessionCard.tsx"));
    const desktop = toCapture("viewport=desktop", loadRaw("session-card"), { viewportLabel: "desktop" });
    const mobile = toCapture("viewport=mobile", loadRaw("session-card-row-mobile"), { viewportLabel: "mobile", screenshot: { path: "/tmp/mobile.png", width: 375, height: 812 } });
    const evidence = buildComponentEvidence({ componentName: "SessionCard", source, captures: [desktop, mobile], analyzerVersion: "test" });
    const bundle = buildInitialBundle(evidence, new EvidenceStore(evidence));

    expect(bundle.text).toMatch(/Layout mode differs across captures/);
    // Still only the default (first) capture's screenshot is surfaced as the primary — the
    // mobile screenshot is available on request via get_evidence, not force-attached.
    expect(bundle.primaryScreenshotPath).toBe("/tmp/viewport=desktop.png");
  });

  it("does not flag a difference when all captures share the same layout mode", () => {
    const source = inspectComponentSource(fixturePath("react/Button.tsx"));
    const a = toCapture("default", loadRaw("button-default"), { propValues: { variant: "primary", size: "medium" } });
    const b = toCapture("variant=secondary,size=large", loadRaw("button-secondary-large"), { propValues: { variant: "secondary", size: "large" } });
    const evidence = buildComponentEvidence({ componentName: "Button", source, captures: [a, b], analyzerVersion: "test" });
    const bundle = buildInitialBundle(evidence, new EvidenceStore(evidence));
    expect(bundle.text).toMatch(/Layout mode is consistent/);
  });
});
