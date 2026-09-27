import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockModelProvider } from "@reactfig/model";
import { unpack } from "@reactfig/artifact";
import type { RenderCapture } from "@reactfig/analyzer";
import { generateDesignIrTool, type CaptureRequest } from "../src/tools/generateDesignIr.js";
import { exportDesignArtifactTool } from "../src/tools/exportDesignArtifact.js";

const projectRoot = fileURLToPath(new URL("./fixtures", import.meta.url));

function fakeCapture(): (request: CaptureRequest) => Promise<RenderCapture> {
  return async (request) => ({
    label: request.label,
    viewport: request.viewport,
    viewportLabel: request.viewportLabel,
    propValues: request.propValues,
    dom: {
      tag: "button",
      attributes: {},
      textContent: null,
      bounds: { x: 0, y: 0, width: 160, height: 48 },
      style: {
        display: "flex",
        layoutMode: "flex",
        position: null,
        zIndex: null,
        flex: { direction: "row", justifyContent: "center", alignItems: "center", wrap: null, gap: 8, rowGap: null, columnGap: null },
        grid: null,
        gridChildPlacement: null,
        padding: { top: 12, right: 24, bottom: 12, left: 24 },
        margin: null,
        backgroundColor: { raw: "rgb(28,97,250)", parsed: { r: 0.11, g: 0.38, b: 0.98, a: 1 } },
        backgroundImage: null,
        backgroundImageUrl: null,
        border: null,
        cornerRadius: { raw: "8px", parsedPx: 8 },
        boxShadow: null,
        opacity: null,
        overflow: null,
        typography: {
          fontFamily: "Inter",
          fontSizePx: 16,
          fontWeight: "600",
          fontStyle: null,
          lineHeight: null,
          lineHeightPx: null,
          letterSpacing: null,
          letterSpacingPx: null,
          textAlign: "center",
          whiteSpace: null,
          textOverflow: null,
          color: { raw: "rgb(255,255,255)", parsed: { r: 1, g: 1, b: 1, a: 1 } },
        },
      },
      image: null,
      componentPath: ["Button"],
      isComponentRoot: true,
      children: [],
    },
    screenshot: null,
    contextScreenshot: null,
    capturedUrl: request.url,
    capturedAt: "2026-08-19T12:00:00.000Z",
  });
}

let tmpDir: string;
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * The primary developer workflow this package exists for:
 * MCP client → generate_design_ir → export_design_artifact → .rfd,
 * with no manual low-level orchestration in between. No network, no real
 * browser, no real model — MockModelProvider + an injected fake capture
 * stand in, same as every other pipeline test in this repository.
 */
describe("MCP pipeline — generate_design_ir then export_design_artifact", () => {
  it("produces a valid, importable .rfd from a source file and a running-app URL/selector alone", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-mcp-pipeline-"));
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({ componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] }),
    });

    const generated = await generateDesignIrTool(
        { sourceFile: "react/Button.tsx", url: "http://localhost:3000", selector: ".btn" },
       { projectRoot, provider, captureComponent: fakeCapture(), checkpointRootDir: join(tmpDir, "checkpoints"), checkpointMapPath: join(tmpDir, "checkpoint-map.json") }
       );
    expect(generated.validation.valid).toBe(true);

    const exported = await exportDesignArtifactTool(
      { document: generated.document, outputPath: "Button.rfd", fetchAssets: false },
      { projectRoot: tmpDir, now: () => "2026-01-01T00:00:00.000Z" }
    );
    expect(exported.warnings).toEqual([]);

    const bytes = new Uint8Array(readFileSync(exported.path));
    const unpacked = await unpack(bytes);
    expect(unpacked.document).toEqual(generated.document);
    expect(unpacked.manifest.root.componentKind).toBe("component");
  });
});
