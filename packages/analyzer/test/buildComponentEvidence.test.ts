import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inspectComponentSource } from "../src/ast/inspectComponentSource.js";
import { interpretDomSnapshot } from "../src/evidence/interpretDomSnapshot.js";
import { buildComponentEvidence } from "../src/buildComponentEvidence.js";
import type { RawDomSnapshot } from "../src/browser/rawTypes.js";
import type { RenderCapture } from "../src/evidence/types.js";

function fixturePath(rel: string): string {
  return fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url));
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
    screenshot: null,
    contextScreenshot: null,
    capturedUrl: "http://localhost:3000/__reactfig_harness__/Button",
    capturedAt: "2026-08-19T12:00:00.000Z",
  };
}

describe("buildComponentEvidence — Button with two captured variants", () => {
  const source = inspectComponentSource(fixturePath("react/Button.tsx"));
  const captures = [
    toCapture("default", loadRaw("button-default"), { variant: "primary", size: "medium" }),
    toCapture("variant=secondary,size=large", loadRaw("button-secondary-large"), {
      variant: "secondary",
      size: "large",
    }),
  ];
  const evidence = buildComponentEvidence({
    componentName: "Button",
    source,
    captures,
    analyzerVersion: "@reactfig/analyzer@0.1.0",
  });

  it("carries both AST evidence and both render captures", () => {
    expect(evidence.componentName).toBe("Button");
    expect(evidence.source.props.map((p) => p.name)).toContain("variant");
    expect(evidence.captures).toHaveLength(2);
  });

  it("each capture's propValues correlate with the AST's variant-axis candidates", () => {
    const variantProp = evidence.source.props.find((p) => p.name === "variant");
    for (const capture of evidence.captures) {
      const value = capture.propValues?.variant;
      expect(variantProp?.literalValues).toContain(value);
    }
  });

  it("does not flag a grid limitation when no capture used CSS Grid", () => {
    expect(evidence.meta.limitations.some((l) => l.includes("CSS Grid"))).toBe(false);
  });

  it("is fully JSON-serializable for inspection/debugging", () => {
    const json = JSON.stringify(evidence);
    const roundTripped = JSON.parse(json);
    expect(roundTripped.captures).toHaveLength(2);
    expect(roundTripped.source.exportName).toBe("Button");
  });
});

describe("buildComponentEvidence — SessionCard (nested composition + CSS Grid fallback flag)", () => {
  const source = inspectComponentSource(fixturePath("react/SessionCard.tsx"));
  const captures = [
    toCapture("default", loadRaw("session-card"), {
      learnerName: "Amir Hosseini",
      status: "completed",
    }),
  ];
  const evidence = buildComponentEvidence({
    componentName: "SessionCard",
    source,
    captures,
    analyzerVersion: "@reactfig/analyzer@0.1.0",
  });

  it("flags the CSS Grid limitation because the capture contains a grid layout", () => {
    expect(evidence.meta.limitations.some((l) => l.includes("CSS Grid"))).toBe(true);
  });

  it("carries the sub-component composition from AST evidence alongside DOM evidence", () => {
    expect(evidence.source.importedComponents.map((c) => c.name).sort()).toEqual(["Avatar", "Badge", "Card"]);
    // DOM evidence independently confirms an <img> and grid children were actually rendered.
    const row = evidence.captures[0].dom.children[1];
    expect(row.children[0].image?.src).toBe("/avatars/amir.png");
  });

  it("always includes the componentPath granularity limitation as a known, disclosed gap", () => {
    expect(evidence.meta.limitations.some((l) => l.includes("componentPath"))).toBe(true);
  });

  it("componentPath corroborates AST-detected sub-component composition", () => {
    const row = evidence.captures[0].dom.children[1];
    const avatar = row.children[0];
    const badge = row.children[1];
    expect(avatar.componentPath).toEqual(["SessionCard", "Avatar"]);
    expect(badge.componentPath).toEqual(["SessionCard", "Badge"]);
    // Both names independently appear in the AST's importedComponents — two
    // deterministic sources agreeing, exactly the corroboration the Evidence
    // Model is meant to provide without claiming a verified 1:1 DOM/JSX map.
    const importedNames = evidence.source.importedComponents.map((c) => c.name);
    expect(importedNames).toContain("Avatar");
    expect(importedNames).toContain("Badge");
  });
});

describe("buildComponentEvidence — responsive captures (viewportLabel) and background-image asset flag", () => {
  const source = inspectComponentSource(fixturePath("react/SessionCard.tsx"));

  it("flags background-image assets when a capture contains one", () => {
    const raw = loadRaw("hero-banner");
    const capture: RenderCapture = {
      label: "viewport=desktop",
      viewport: { width: 1440, height: 900 },
      viewportLabel: "desktop",
      dom: interpretDomSnapshot(raw),
      screenshot: null,
      contextScreenshot: null,
      capturedUrl: "http://localhost:3000",
      capturedAt: "2026-08-19T12:00:00.000Z",
    };
    const evidence = buildComponentEvidence({
      componentName: "SessionCard",
      source,
      captures: [capture],
      analyzerVersion: "@reactfig/analyzer@0.1.0",
    });
    expect(evidence.meta.limitations.some((l) => l.includes("Background-image"))).toBe(true);
  });

  it("does not flag the background-image limitation when no capture has one", () => {
    const capture = toCapture("default", loadRaw("session-card"));
    const evidence = buildComponentEvidence({
      componentName: "SessionCard",
      source,
      captures: [capture],
      analyzerVersion: "@reactfig/analyzer@0.1.0",
    });
    expect(evidence.meta.limitations.some((l) => l.includes("Background-image"))).toBe(false);
  });

  it("expresses the same component at two viewports as two distinct captures via viewportLabel, not merged", () => {
    const desktop: RenderCapture = {
      label: "viewport=desktop",
      viewport: { width: 1440, height: 900 },
      viewportLabel: "desktop",
      dom: interpretDomSnapshot(loadRaw("session-card")).children[1], // the row: grid on desktop
      screenshot: null,
      contextScreenshot: null,
      capturedUrl: "http://localhost:3000",
      capturedAt: "2026-08-19T12:00:00.000Z",
    };
    const mobile: RenderCapture = {
      label: "viewport=mobile",
      viewport: { width: 375, height: 812 },
      viewportLabel: "mobile",
      dom: interpretDomSnapshot(loadRaw("session-card-row-mobile")), // same row: flex-column on mobile
      screenshot: null,
      contextScreenshot: null,
      capturedUrl: "http://localhost:3000",
      capturedAt: "2026-08-19T12:00:00.000Z",
    };
    const evidence = buildComponentEvidence({
      componentName: "SessionCard",
      source,
      captures: [desktop, mobile],
      analyzerVersion: "@reactfig/analyzer@0.1.0",
    });
    expect(evidence.captures).toHaveLength(2);
    expect(evidence.captures[0].dom.style.layoutMode).toBe("grid");
    expect(evidence.captures[1].dom.style.layoutMode).toBe("flex");
    expect(evidence.captures.map((c) => c.viewportLabel)).toEqual(["desktop", "mobile"]);
  });
});
