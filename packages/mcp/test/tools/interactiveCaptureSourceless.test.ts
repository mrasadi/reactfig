import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockModelProvider } from "@reactfig/model";
import type { RawDomSnapshot } from "@reactfig/analyzer";
import { startInteractiveCaptureTool, type StartInteractiveCaptureContext } from "../../src/tools/startInteractiveCapture.js";
import { finalizeInteractiveCaptureTool } from "../../src/tools/finalizeInteractiveCapture.js";
import { generateDesignIrFromCaptureTool } from "../../src/tools/generateDesignIrFromCapture.js";
import { CollectionSession } from "../../src/collection/collectionSession.js";
import type { InteractiveBrowserHandle } from "../../src/collection/collectionBrowser.js";

let projectRoot: string;
let checkpointRoot: string;
afterEach(() => {
  if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
  if (checkpointRoot) rmSync(checkpointRoot, { recursive: true, force: true });
});

function fakeRawSnapshot(componentPath: string[]): RawDomSnapshot {
  return {
    tag: "div",
    attributes: { className: "stat-card" },
    textContent: null,
    rect: { x: 0, y: 0, width: 240, height: 96 },
    computedStyle: { display: "flex" },
    naturalWidth: null,
    naturalHeight: null,
    componentPath,
    children: [],
  };
}

function fakeAttachBrowser(): StartInteractiveCaptureContext["attachBrowser"] {
  return async (): Promise<InteractiveBrowserHandle> => ({ page: {}, close: async () => {} } as unknown as InteractiveBrowserHandle);
}

function makeSessionRegistry() {
  const active = new Map<string, { session: CollectionSession; browser: InteractiveBrowserHandle }>();
  return {
    registerActiveSession: (id: string, entry: { session: CollectionSession; browser: InteractiveBrowserHandle }) => active.set(id, entry),
    getActiveSession: (id: string) => active.get(id),
    dropActiveSession: (id: string) => active.delete(id),
  };
}

describe("Interactive Capture — source-less (no React source) end-to-end (Feature B)", () => {
  it("captures a selection with NO sourceFile and produces a valid Design IR from evidence alone", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "reactfig-sourceless-e2e-"));
    const registry = makeSessionRegistry();

    const started = await startInteractiveCaptureTool(
      { url: "http://localhost:3000/dashboard", defaultOutputFormat: "svg" },
      { projectRoot, attachBrowser: fakeAttachBrowser(), registerActiveSession: registry.registerActiveSession }
    );
    const { collectionId } = started;
    const { session } = registry.getActiveSession(collectionId)!;

    await session.captureSelection({
      url: "http://localhost:3000/dashboard",
      pageTitle: "Dashboard",
      componentPath: ["Dashboard", "StatCard"],
      selector: "#stat-1",
      tag: "div",
      rect: { x: 0, y: 0, width: 240, height: 96 },
      rawSnapshot: fakeRawSnapshot(["Dashboard", "StatCard"]),
      screenshot: Buffer.from("png-1"),
      outputFormat: "json", // selection-level override, should win over the collection's "svg" default
    });

    const finalized = await finalizeInteractiveCaptureTool(
      { collectionId },
      { projectRoot, getActiveSession: registry.getActiveSession, dropActiveSession: registry.dropActiveSession }
    );
    expect(finalized.manifest.status).toBe("completed");

    checkpointRoot = mkdtempSync(join(tmpdir(), "reactfig-sourceless-e2e-checkpoints-"));
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({ componentDisplayName: "StatCard", variantAxes: [], nodeAnnotations: [] }),
    });

    const selectionId = finalized.selections[0].selectionId;
    // No sourceFile at all — this is the whole point of Feature B.
    const result = await generateDesignIrFromCaptureTool(
      { collectionId, selectionId },
      {
        projectRoot,
        provider,
        checkpointRootDir: checkpointRoot,
        checkpointMapPath: join(checkpointRoot, "checkpoint-map.json"),
        collectionsRootDir: join(projectRoot, ".reactfig", "collections"),
      }
    );

    expect(result.validation.valid).toBe(true);
    // componentName falls back to the selection's own recorded component path when not given explicitly.
    expect(result.componentName).toBe("StatCard");
    // Output Intent resolved from THIS selection's own override, not the collection default.
    expect(result.outputFormat).toBe("json");
  });

  it("resolves outputFormat to the collection's default when a selection has no override of its own", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "reactfig-sourceless-e2e-"));
    const registry = makeSessionRegistry();

    const started = await startInteractiveCaptureTool(
      { url: "http://localhost:3000/dashboard", defaultOutputFormat: "html" },
      { projectRoot, attachBrowser: fakeAttachBrowser(), registerActiveSession: registry.registerActiveSession }
    );
    const { collectionId } = started;
    const { session } = registry.getActiveSession(collectionId)!;

    await session.captureSelection({
      url: "http://localhost:3000/dashboard",
      pageTitle: "Dashboard",
      componentPath: ["Dashboard", "UnknownCard"],
      selector: "#unknown-1",
      tag: "div",
      rect: { x: 0, y: 0, width: 200, height: 80 },
      rawSnapshot: fakeRawSnapshot(["Dashboard", "UnknownCard"]),
      screenshot: Buffer.from("png-2"),
      // no outputFormat override here
    });

    const finalized = await finalizeInteractiveCaptureTool(
      { collectionId },
      { projectRoot, getActiveSession: registry.getActiveSession, dropActiveSession: registry.dropActiveSession }
    );

    checkpointRoot = mkdtempSync(join(tmpdir(), "reactfig-sourceless-e2e-checkpoints-"));
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({ componentDisplayName: "UnknownCard", variantAxes: [], nodeAnnotations: [] }),
    });

    const result = await generateDesignIrFromCaptureTool(
      { collectionId, selectionId: finalized.selections[0].selectionId, componentName: "UnknownCard" },
      {
        projectRoot,
        provider,
        checkpointRootDir: checkpointRoot,
        checkpointMapPath: join(checkpointRoot, "checkpoint-map.json"),
        collectionsRootDir: join(projectRoot, ".reactfig", "collections"),
      }
    );

    expect(result.outputFormat).toBe("html");
  });
});
