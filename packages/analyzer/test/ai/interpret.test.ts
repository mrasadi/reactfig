import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MockModelProvider } from "@reactfig/model";
import { interpretComponent, MAX_TOOL_ITERATIONS } from "../../src/ai/interpret.js";
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
    screenshot: { path: `/tmp/${label}.png`, width: 160, height: 48 },
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

const trivialInterpretation: ComponentInterpretation = {
  componentDisplayName: "Button",
  variantAxes: [{ propName: "variant", confirmedValues: ["primary", "secondary"], rationale: "both rendered" }],
  nodeAnnotations: [],
};

describe("interpretComponent — tool-calling loop", () => {
  it("lets the model call get_evidence and incorporates the result before finalizing", async () => {
    const evidence = buttonEvidence();
    let sawSourceInToolResult = false;

    const provider = new MockModelProvider({
      onGenerateWithTools: (input, callIndex) => {
        if (callIndex === 0) {
          return { text: null, toolCalls: [{ id: "1", name: "get_evidence", arguments: { kind: "source" } }] };
        }
        // second call: the tool result should now be in the message history
        const toolMessage = input.messages.find((m) => m.role === "tool");
        const text = toolMessage?.content.find((c) => c.type === "text");
        if (text && text.type === "text" && text.text.includes('"exportName":"Button"')) sawSourceInToolResult = true;
        return { text: "done", toolCalls: [] };
      },
      onGenerateStructured: () => trivialInterpretation,
    });

    const result = await interpretComponent(provider, evidence);
    expect(result.toolCallCount).toBe(1);
    expect(sawSourceInToolResult).toBe(true);
    expect(result.interpretation.componentDisplayName).toBe("Button");
  });

  it("stops the loop as soon as the model returns no tool calls", async () => {
    const evidence = buttonEvidence();
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "no tools needed", toolCalls: [] }),
      onGenerateStructured: () => trivialInterpretation,
    });
    const result = await interpretComponent(provider, evidence);
    expect(result.toolCallCount).toBe(0);
    expect(result.hitIterationBudget).toBe(false);
  });

  it("stops after MAX_TOOL_ITERATIONS and still finalizes, flagging the budget in notes", async () => {
    const evidence = buttonEvidence();
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: null, toolCalls: [{ id: "x", name: "get_evidence", arguments: { kind: "source" } }] }),
      onGenerateStructured: () => ({ ...trivialInterpretation }),
    });
    const result = await interpretComponent(provider, evidence);
    expect(result.toolCallCount).toBe(MAX_TOOL_ITERATIONS);
    expect(result.hitIterationBudget).toBe(true);
    expect(result.interpretation.notes).toMatch(/tool-call budget/);
  });
});

describe("interpretComponent — capability branching", () => {
  it("skips the tool loop entirely for a provider without toolCalling, going straight to structured output", async () => {
    const evidence = buttonEvidence();
    let toolLoopCalled = false;
    const provider = new MockModelProvider({
      capabilities: { toolCalling: false },
      onGenerateWithTools: () => {
        toolLoopCalled = true;
        return { text: "should not happen", toolCalls: [] };
      },
      onGenerateStructured: () => trivialInterpretation,
    });
    const result = await interpretComponent(provider, evidence);
    expect(toolLoopCalled).toBe(false);
    expect(result.toolCallCount).toBe(0);
  });

  it("does not attach an image part when the provider lacks vision, even if a screenshot exists", async () => {
    const evidence = buttonEvidence();
    let sawImagePart = false;
    const provider = new MockModelProvider({
      capabilities: { vision: false },
      onGenerateWithTools: (input) => {
        const first = input.messages[0];
        if (first.content.some((c) => c.type === "image")) sawImagePart = true;
        return { text: "done", toolCalls: [] };
      },
      onGenerateStructured: () => trivialInterpretation,
    });
    await interpretComponent(provider, evidence);
    expect(sawImagePart).toBe(false);
  });

  it("attaches the primary screenshot as an image part when the provider has vision", async () => {
    const evidence = buttonEvidence();
    let sawImagePart = false;
    const provider = new MockModelProvider({
      capabilities: { vision: true },
      onGenerateWithTools: (input) => {
        const first = input.messages[0];
        if (first.content.some((c) => c.type === "image")) sawImagePart = true;
        return { text: "done", toolCalls: [] };
      },
      onGenerateStructured: () => trivialInterpretation,
    });
    await interpretComponent(provider, evidence);
    expect(sawImagePart).toBe(true);
  });
});

describe("interpretComponent — anti-hallucination enforcement (variants)", () => {
  it("drops a variantAxes entry for a prop that isn't a real variant-capable prop in evidence", async () => {
    const evidence = buttonEvidence();
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({
        componentDisplayName: "Button",
        variantAxes: [{ propName: "onClick", confirmedValues: ["whatever"], rationale: "hallucinated" }],
        nodeAnnotations: [],
      }),
    });
    const result = await interpretComponent(provider, evidence);
    expect(result.interpretation.variantAxes).toEqual([]);
  });

  it("drops a confirmedValue not present in the prop's actual literalValues, keeping the ones that are", async () => {
    const evidence = buttonEvidence();
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({
        componentDisplayName: "Button",
        variantAxes: [{ propName: "variant", confirmedValues: ["primary", "tertiary"], rationale: "tertiary is invented" }],
        nodeAnnotations: [],
      }),
    });
    const result = await interpretComponent(provider, evidence);
    expect(result.interpretation.variantAxes).toEqual([
      { propName: "variant", confirmedValues: ["primary"], rationale: "tertiary is invented" },
    ]);
  });

  it("appends options.guidance to the system prompt seen by the model — docs/adr/0013's addendum (a real MCP client's `prompt` argument, previously silently dropped)", async () => {
    const evidence = buttonEvidence();
    let sawGuidanceInStructuredCall = false;
    let sawGuidanceInToolCall = false;

    const provider = new MockModelProvider({
      onGenerateWithTools: (input) => {
        if (input.system?.includes("focus on the avatar's status-dot overlay")) sawGuidanceInToolCall = true;
        return { text: "done", toolCalls: [] };
      },
      onGenerateStructured: (input) => {
        if (input.system?.includes("focus on the avatar's status-dot overlay")) sawGuidanceInStructuredCall = true;
        return { componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] };
      },
    });

    await interpretComponent(provider, evidence, { guidance: "focus on the avatar's status-dot overlay" });

    expect(sawGuidanceInToolCall).toBe(true);
    expect(sawGuidanceInStructuredCall).toBe(true);
  });
});
