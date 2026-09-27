import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MockModelProvider } from "@reactfig/model";
import { pack, unpack } from "@reactfig/artifact";
import { generateDesignIR } from "../../src/ai/orchestrate.js";
import { buildComponentEvidence } from "../../src/buildComponentEvidence.js";
import { inspectComponentSource } from "../../src/ast/inspectComponentSource.js";
import { interpretDomSnapshot } from "../../src/evidence/interpretDomSnapshot.js";
import type { RawDomSnapshot } from "../../src/browser/rawTypes.js";
import type { RenderCapture } from "../../src/evidence/types.js";
import type { ComponentInterpretation } from "../../src/ai/types.js";

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
    screenshot: null,
    contextScreenshot: null,
    capturedUrl: "http://localhost:3000",
    capturedAt: "2026-08-19T12:00:00.000Z",
    ...opts,
  };
}

/**
 * The Phase 5 quality gate: React fixture → deterministic evidence →
 * mocked AI interpretation → Design IR → validation → .rfd → unpack →
 * semantically identical, still-valid IR. No network, no real model — the
 * MockModelProvider script stands in for "AI orchestration" the same way
 * every other Phase 4 test does.
 */
describe("full chain — Button (variants) round-trips through .rfd unchanged", () => {
  it("produces an identical, still-valid Design IR after pack/unpack", async () => {
    const source = inspectComponentSource(fixturePath("react/Button.tsx"));
    const captures = [
      toCapture("default", loadRaw("button-default"), { propValues: { variant: "primary", size: "medium" } }),
      toCapture("variant=secondary,size=large", loadRaw("button-secondary-large"), { propValues: { variant: "secondary", size: "large" } }),
    ];
    const evidence = buildComponentEvidence({ componentName: "Button", source, captures, analyzerVersion: "test" });

    const mockInterpretation: ComponentInterpretation = {
      componentDisplayName: "Button",
      variantAxes: [{ propName: "variant", confirmedValues: ["primary", "secondary"], rationale: "both captured" }],
      nodeAnnotations: [],
    };
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "evidence bundle is sufficient", toolCalls: [] }),
      onGenerateStructured: () => mockInterpretation,
    });

    const generated = await generateDesignIR(provider, evidence);
    expect(generated.validation.valid).toBe(true);

    const packed = await pack(generated.document, { createdAt: "2026-01-01T00:00:00.000Z" });
    const unpacked = await unpack(packed.bytes);

    // No assets on this component, so pack() never rewrites anything — the
    // round-tripped document should be byte-for-byte semantically identical.
    expect(unpacked.document).toEqual(generated.document);
    expect(unpacked.manifest.root.componentKind).toBe("componentSet");
    expect(unpacked.manifest.componentCount).toBe(1);
  });
});

describe("full chain — SessionCard (nested composition + responsive evidence)", () => {
  it("resolves two-viewport evidence into one representative IR layout, and round-trips through .rfd", async () => {
    const source = inspectComponentSource(fixturePath("react/SessionCard.tsx"));
    // Responsive evidence: desktop capture is CSS Grid, mobile capture (of just the row) is a flex column —
    // per docs/analyzer/evidence-model.md this stays evidence, never merged; buildDesignIR resolves to ONE
    // representative layout (the default/desktop capture) for the v1 IR document.
    const desktop = toCapture("viewport=desktop", loadRaw("session-card"), { viewportLabel: "desktop" });
    const mobileRow = toCapture("viewport=mobile", loadRaw("session-card-row-mobile"), { viewportLabel: "mobile" });
    const evidence = buildComponentEvidence({ componentName: "SessionCard", source, captures: [desktop, mobileRow], analyzerVersion: "test" });

    // Sanity check the responsive-evidence premise itself before trusting the IR built on top of it.
    expect(desktop.dom.children[1].style.layoutMode).toBe("grid");
    expect(mobileRow.dom.style.layoutMode).toBe("flex");

    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({ componentDisplayName: "SessionCard", variantAxes: [], nodeAnnotations: [] }),
    });

    const generated = await generateDesignIR(provider, evidence);
    expect(generated.validation.valid).toBe(true);

    const component = generated.document.components[0];
    if (component.kind !== "component") throw new Error("expected component");
    if (component.root.type !== "frame") throw new Error("expected frame root");
    // The IR was built from the desktop (default) capture — the grid fallback (ADR 0002) is what's present.
    const row = component.root.children[1];
    if (row.type !== "frame") throw new Error("expected frame row");
    expect(row.layout).toEqual({ mode: "none" });
    expect(row.children.map((c) => c.type)).toEqual(["instance", "instance"]);

    const packed = await pack(generated.document, { createdAt: "2026-01-01T00:00:00.000Z" });
    const unpacked = await unpack(packed.bytes);
    expect(unpacked.document).toEqual(generated.document);
  });
});
