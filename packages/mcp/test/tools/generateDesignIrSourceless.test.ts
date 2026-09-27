import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockModelProvider } from "@reactfig/model";
import { generateDesignIrTool, type CaptureRequest } from "../../src/tools/generateDesignIr.js";
import type { RenderCapture } from "@reactfig/analyzer";

const projectRoot = fileURLToPath(new URL("../fixtures", import.meta.url));

let checkpointRoot: string;
afterEach(() => {
  if (checkpointRoot) rmSync(checkpointRoot, { recursive: true, force: true });
});

function withCheckpoints(ctx: Parameters<typeof generateDesignIrTool>[1]): Parameters<typeof generateDesignIrTool>[1] {
  checkpointRoot = mkdtempSync(join(tmpdir(), "reactfig-sourceless-checkpoint-"));
  return { ...ctx, checkpointRootDir: checkpointRoot, checkpointMapPath: join(checkpointRoot, "checkpoint-map.json") };
}

function fakeDom(): RenderCapture["dom"] {
  return {
    tag: "div",
    attributes: { class: "card" },
    textContent: null,
    bounds: { x: 0, y: 0, width: 240, height: 96 },
    style: {
      display: "flex",
      layoutMode: "flex",
      position: null,
      zIndex: null,
      flex: { direction: "row", justifyContent: "flex-start", alignItems: "center", wrap: null, gap: 12, rowGap: null, columnGap: null },
      grid: null,
      gridChildPlacement: null,
      padding: { top: 16, right: 16, bottom: 16, left: 16 },
      margin: null,
      backgroundColor: { raw: "rgb(255, 255, 255)", parsed: { r: 1, g: 1, b: 1, a: 1 } },
      backgroundImage: null,
      backgroundImageUrl: null,
      border: null,
      cornerRadius: { raw: "12px", parsedPx: 12 },
      boxShadow: null,
      opacity: null,
      overflow: null,
      typography: null,
    },
    children: [],
  } as unknown as RenderCapture["dom"];
}

function makeFakeCapture(): (request: CaptureRequest) => Promise<RenderCapture> {
  return async (request: CaptureRequest): Promise<RenderCapture> => ({
    label: request.label,
    viewport: request.viewport,
    viewportLabel: request.viewportLabel,
    propValues: request.propValues,
    dom: fakeDom(),
    screenshot: null,
    contextScreenshot: null,
    capturedUrl: request.url,
    capturedAt: "2026-08-19T12:00:00.000Z",
  });
}

describe("generateDesignIrTool — source-less generation (Feature B)", () => {
  it("generates a valid Design IR without a sourceFile, given componentName + sourceFingerprint", async () => {
    const capture = makeFakeCapture();
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({ componentDisplayName: "StatCard", variantAxes: [], nodeAnnotations: [] }),
    });

    const result = await generateDesignIrTool(
      { componentName: "StatCard", sourceFingerprint: "fingerprint-abc", url: "http://localhost:3000/dashboard", selector: "#stat-1" },
      withCheckpoints({ projectRoot, provider, captureComponent: capture })
    );

    expect(result.componentName).toBe("StatCard");
    expect(result.validation.valid).toBe(true);
    expect(result.document.components[0]?.name).toBe("StatCard");
  });

  it("requires componentName when sourceFile is omitted", async () => {
    const capture = makeFakeCapture();
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({ componentDisplayName: "X", variantAxes: [], nodeAnnotations: [] }),
    });

    await expect(
      generateDesignIrTool(
        { sourceFingerprint: "abc", url: "http://localhost:3000", selector: "#x" },
        withCheckpoints({ projectRoot, provider, captureComponent: capture })
      )
    ).rejects.toThrow(/componentName.*required/);
  });

  it("requires sourceFingerprint when sourceFile is omitted", async () => {
    const capture = makeFakeCapture();
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({ componentDisplayName: "X", variantAxes: [], nodeAnnotations: [] }),
    });

    await expect(
      generateDesignIrTool(
        { componentName: "X", url: "http://localhost:3000", selector: "#x" },
        withCheckpoints({ projectRoot, provider, captureComponent: capture })
      )
    ).rejects.toThrow(/sourceFingerprint.*required/);
  });

  it("marks the evidence provenance so an inferred structure is never mistaken for source-declared (docs section 15)", async () => {
    const capture = makeFakeCapture();
    let seenLimitations: string[] = [];
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: (messages: unknown) => {
        seenLimitations = JSON.stringify(messages).includes("Source-less generation") ? ["found"] : [];
        return { componentDisplayName: "StatCard", variantAxes: [], nodeAnnotations: [] };
      },
    });

    await generateDesignIrTool(
      { componentName: "StatCard", sourceFingerprint: "fp-1", url: "http://localhost:3000", selector: "#stat-1" },
      withCheckpoints({ projectRoot, provider, captureComponent: capture })
    );

    expect(seenLimitations).toEqual(["found"]);
  });

  it("still works exactly as before when sourceFile IS given (backward compatibility)", async () => {
    const capture = makeFakeCapture();
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({ componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] }),
    });

    const result = await generateDesignIrTool(
      { sourceFile: "react/Button.tsx", url: "http://localhost:3000", selector: ".btn" },
      withCheckpoints({ projectRoot, provider, captureComponent: capture })
    );

    expect(result.componentName).toBe("Button");
    expect(result.validation.valid).toBe(true);
  });
});
