import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MockModelProvider } from "@reactfig/model";
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
function toCapture(label: string, raw: RawDomSnapshot, propValues?: Record<string, unknown>): RenderCapture {
  return {
    label,
    viewport: { width: 1440, height: 900 },
    propValues,
    dom: interpretDomSnapshot(raw),
    screenshot: null,
    contextScreenshot: null,
    capturedUrl: "http://localhost:3000",
    capturedAt: "2026-08-19T12:00:00.000Z",
  };
}

function buttonEvidence() {
  const source = inspectComponentSource(fixturePath("react/Button.tsx"));
  const captures = [
    toCapture("default", loadRaw("button-default"), { variant: "primary", size: "medium" }),
    toCapture("variant=secondary,size=large", loadRaw("button-secondary-large"), { variant: "secondary", size: "large" }),
  ];
  return buildComponentEvidence({ componentName: "Button", source, captures, analyzerVersion: "test" });
}

function sessionCardEvidence() {
  const source = inspectComponentSource(fixturePath("react/SessionCard.tsx"));
  const captures = [toCapture("default", loadRaw("session-card"), { status: "completed" })];
  return buildComponentEvidence({ componentName: "SessionCard", source, captures, analyzerVersion: "test" });
}

const validButtonInterpretation: ComponentInterpretation = {
  componentDisplayName: "Button",
  variantAxes: [{ propName: "variant", confirmedValues: ["primary", "secondary"], rationale: "both captured" }],
  nodeAnnotations: [],
};

describe("generateDesignIR — end-to-end with a deterministic mock model (Button)", () => {
  it("produces a validated Design IR document on the first attempt", async () => {
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "no tools needed, evidence bundle is sufficient", toolCalls: [] }),
      onGenerateStructured: () => validButtonInterpretation,
    });
    const result = await generateDesignIR(provider, buttonEvidence());
    expect(result.attempts).toBe(1);
    expect(result.validation.valid).toBe(true);
    expect(result.document.components[0].kind).toBe("componentSet");
  });

  it("throws a clear error for a provider without structuredOutput, rather than attempting fragile text parsing", async () => {
    const provider = new MockModelProvider({ capabilities: { structuredOutput: false } });
    await expect(generateDesignIR(provider, buttonEvidence())).rejects.toThrow(/requires a ModelProvider with structuredOutput/);
  });
});

describe("generateDesignIR — end-to-end with a deterministic mock model (SessionCard, nested composition)", () => {
  it("produces a validated Design IR with Avatar/Badge collapsed to instances, no AI annotation required", async () => {
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({ componentDisplayName: "SessionCard", variantAxes: [], nodeAnnotations: [] }),
    });
    const result = await generateDesignIR(provider, sessionCardEvidence());
    expect(result.validation.valid).toBe(true);
    const component = result.document.components[0];
    if (component.kind !== "component") throw new Error("expected component");
    if (component.root.type !== "frame") throw new Error("expected frame");
    const row = component.root.children[1];
    if (row.type !== "frame") throw new Error("expected frame row");
    expect(row.children.map((c) => c.type)).toEqual(["instance", "instance"]);
  });
});

describe("generateDesignIR — bounded repair loop", () => {
  it("repairs an invalid interpretation (empty node name) within the retry budget", async () => {
    let call = 0;
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => {
        call++;
        if (call === 1) {
          // first attempt: an empty semanticName violates IR's minLength:1 on node names
          return { componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [{ path: [], semanticName: "" }] };
        }
        return { componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] };
      },
    });
    const result = await generateDesignIR(provider, buttonEvidence());
    expect(result.attempts).toBe(2);
    expect(result.validation.valid).toBe(true);
  });

  it("passes validation errors back to the model as repair context on the retry", async () => {
    let sawRepairContext = false;
    let call = 0;
    const provider = new MockModelProvider({
      onGenerateWithTools: (input) => {
        if (input.system?.includes("Validation errors")) sawRepairContext = true;
        return { text: "done", toolCalls: [] };
      },
      onGenerateStructured: () => {
        call++;
        return call === 1
          ? { componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [{ path: [], semanticName: "" }] }
          : { componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] };
      },
    });
    await generateDesignIR(provider, buttonEvidence());
    expect(sawRepairContext).toBe(true);
  });

  it("gives up after exhausting the repair budget and returns the last (invalid) attempt rather than throwing", async () => {
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      // always returns an invalid interpretation
      onGenerateStructured: () => ({ componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [{ path: [], semanticName: "" }] }),
    });
    const result = await generateDesignIR(provider, buttonEvidence(), { maxRepairAttempts: 2 });
    expect(result.attempts).toBe(3); // 1 initial + 2 repairs
    expect(result.validation.valid).toBe(false);
    expect(result.validation.errors.length).toBeGreaterThan(0);
  });

  it("respects a custom maxRepairAttempts of 0 (no repair at all)", async () => {
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({ componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [{ path: [], semanticName: "" }] }),
    });
    const result = await generateDesignIR(provider, buttonEvidence(), { maxRepairAttempts: 0 });
    expect(result.attempts).toBe(1);
    expect(result.validation.valid).toBe(false);
  });
});
