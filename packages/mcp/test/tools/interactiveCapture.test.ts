import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockModelProvider } from "@reactfig/model";
import type { RawDomSnapshot } from "@reactfig/analyzer";
import { startInteractiveCaptureTool, type StartInteractiveCaptureContext } from "../../src/tools/startInteractiveCapture.js";
import { getInteractiveCaptureStatusTool } from "../../src/tools/getInteractiveCaptureStatus.js";
import { finalizeInteractiveCaptureTool } from "../../src/tools/finalizeInteractiveCapture.js";
import { generateDesignIrFromCaptureTool } from "../../src/tools/generateDesignIrFromCapture.js";
import { CollectionSession } from "../../src/collection/collectionSession.js";
import type { InteractiveBrowserHandle } from "../../src/collection/collectionBrowser.js";
import { CollectionStateError } from "../../src/collection/collectionManifest.js";

const sourceFixtureRoot = fileURLToPath(new URL("../fixtures", import.meta.url));

let projectRoot: string;
let checkpointRoot: string;
afterEach(() => {
  if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
  if (checkpointRoot) rmSync(checkpointRoot, { recursive: true, force: true });
});

function fakeRawSnapshot(componentPath: string[]): RawDomSnapshot {
  return {
    tag: "button",
    attributes: { className: "btn" },
    textContent: "Click me",
    rect: { x: 0, y: 0, width: 160, height: 48 },
    computedStyle: { display: "flex" },
    naturalWidth: null,
    naturalHeight: null,
    componentPath,
    children: [],
  };
}

/** A fake attachBrowser that never touches Playwright — this is the same seam GenerateDesignIrContext.captureComponent already uses to keep tests independent of a real browser binary (see generateDesignIr.test.ts's makeFakeCapture). */
function fakeAttachBrowser(): StartInteractiveCaptureContext["attachBrowser"] {
  return async (): Promise<InteractiveBrowserHandle> =>
    ({ page: {}, close: async () => {} } as unknown as InteractiveBrowserHandle);
}

/**
 * A fake attachBrowser whose `page` supports just enough of Playwright's
 * EventEmitter-style API (`page.once`, `page.context().browser()`) to
 * exercise startInteractiveCaptureTool's auto-drop wiring, plus `fireClose`/
 * `fireDisconnected` so a test can simulate the browser going away without
 * a real one.
 */
function fakeAttachBrowserWithEvents(): { attachBrowser: StartInteractiveCaptureContext["attachBrowser"]; fireClose: () => void; fireDisconnected: () => void } {
  const pageListeners: Array<() => void> = [];
  const browserListeners: Array<() => void> = [];
  const fakeBrowser = { once: (_event: string, cb: () => void) => { browserListeners.push(cb); } };
  const fakePage = {
    once: (_event: string, cb: () => void) => { pageListeners.push(cb); },
    context: () => ({ browser: () => fakeBrowser }),
  };
  return {
    attachBrowser: async (): Promise<InteractiveBrowserHandle> => ({ page: fakePage, close: async () => {} } as unknown as InteractiveBrowserHandle),
    fireClose: () => pageListeners.forEach((cb) => cb()),
    fireDisconnected: () => browserListeners.forEach((cb) => cb()),
  };
}

/** Minimal in-process stand-in for server.ts's activeInteractiveSessions Map. */
function makeSessionRegistry() {
  const active = new Map<string, { session: CollectionSession; browser: InteractiveBrowserHandle }>();
  return {
    registerActiveSession: (id: string, entry: { session: CollectionSession; browser: InteractiveBrowserHandle }) => active.set(id, entry),
    getActiveSession: (id: string) => active.get(id),
    dropActiveSession: (id: string) => active.delete(id),
  };
}

describe("Interactive Capture — full workflow (start, selections, remove, navigate, finalize, pipeline)", () => {
  it("start -> selection -> confirm -> second selection -> remove -> navigate -> third selection -> review -> finalize -> generate_design_ir_from_capture produces a validated Design IR", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "reactfig-interactive-"));
    const registry = makeSessionRegistry();

    // start_interactive_capture
    const started = await startInteractiveCaptureTool(
      { url: "http://localhost:3000/dashboard" },
      { projectRoot, attachBrowser: fakeAttachBrowser(), registerActiveSession: registry.registerActiveSession }
    );
    expect(started.status).toBe("created");
    const { collectionId } = started;
    const { session } = registry.getActiveSession(collectionId)!;

    // developer selects and confirms on Page A
    await session.captureSelection({
      url: "http://localhost:3000/dashboard",
      pageTitle: "Dashboard",
      componentPath: ["Dashboard", "Button"],
      selector: "#btn-1",
      tag: "button",
      rect: { x: 0, y: 0, width: 160, height: 48 },
      rawSnapshot: fakeRawSnapshot(["Dashboard", "Button"]),
      screenshot: Buffer.from("png-1"),
    });

    // a second selection, still on Page A
    await session.captureSelection({
      url: "http://localhost:3000/dashboard",
      pageTitle: "Dashboard",
      componentPath: ["Dashboard", "Button"],
      selector: "#btn-2",
      tag: "button",
      rect: { x: 0, y: 60, width: 160, height: 48 },
      rawSnapshot: fakeRawSnapshot(["Dashboard", "Button"]),
      screenshot: Buffer.from("png-2"),
    });

    // status check mid-collection
    const statusAfterTwo = await getInteractiveCaptureStatusTool({ collectionId }, { projectRoot, getActiveSession: registry.getActiveSession });
    expect(statusAfterTwo.activeSelectionCount).toBe(2);
    expect(statusAfterTwo.browserAttached).toBe(true);

    // developer removes the second selection
    await session.remove(statusAfterTwo.manifest.selections[1].selectionId);

    // developer navigates to Page B and captures a third selection
    const thirdManifest = await session.captureSelection({
      url: "http://localhost:3000/speaking",
      pageTitle: "Speaking",
      componentPath: ["Speaking", "Button"],
      selector: "#btn-3",
      tag: "button",
      rect: { x: 0, y: 0, width: 160, height: 48 },
      rawSnapshot: fakeRawSnapshot(["Speaking", "Button"]),
      screenshot: Buffer.from("png-3"),
    });

    // review before finalizing
    const review = await getInteractiveCaptureStatusTool({ collectionId }, { projectRoot, getActiveSession: registry.getActiveSession });
    expect(review.activeSelectionCount).toBe(2);
    expect(review.removedSelectionCount).toBe(1);
    expect(new Set(thirdManifest.selections.map((s) => s.url)).size).toBe(2); // two distinct pages, one collection

    // finalize
    const finalized = await finalizeInteractiveCaptureTool(
      { collectionId },
      { projectRoot, getActiveSession: registry.getActiveSession, dropActiveSession: registry.dropActiveSession }
    );
    expect(finalized.manifest.status).toBe("completed");
    expect(finalized.selections).toHaveLength(2);
    expect(finalized.browserClosed).toBe(true);
    expect(registry.getActiveSession(collectionId)).toBeUndefined();

    // pipeline continues, browser closed, from persisted evidence alone
    checkpointRoot = mkdtempSync(join(tmpdir(), "reactfig-interactive-checkpoints-"));
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({ componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] }),
    });

    const firstSelectionId = finalized.selections[0].selectionId;
    const result = await generateDesignIrFromCaptureTool(
      { collectionId, selectionId: firstSelectionId, sourceFile: "react/Button.tsx" },
      { projectRoot: sourceFixtureRoot, provider, checkpointRootDir: checkpointRoot, checkpointMapPath: join(checkpointRoot, "checkpoint-map.json"), collectionsRootDir: join(projectRoot, ".reactfig", "collections") }
    );

    expect(result.componentName).toBe("Button");
    expect(result.captureCount).toBe(1);
    expect(result.validation.valid).toBe(true);
  });

  it("generate_design_ir_from_capture refuses to run against a collection that hasn't been finalized yet", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "reactfig-interactive-"));
    const session = await CollectionSession.create({ projectRoot, entryUrl: "http://localhost:3000" });
    await session.captureSelection({
      url: "http://localhost:3000",
      pageTitle: "Home",
      componentPath: ["Button"],
      selector: "#btn-1",
      tag: "button",
      rect: { x: 0, y: 0, width: 160, height: 48 },
      rawSnapshot: fakeRawSnapshot(["Button"]),
      screenshot: Buffer.from("png-1"),
    });

    const provider = new MockModelProvider({ onGenerateWithTools: () => ({ text: "done", toolCalls: [] }), onGenerateStructured: () => ({ componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] }) });
    await expect(
      generateDesignIrFromCaptureTool(
        { collectionId: session.collectionId, selectionId: "sel_001", sourceFile: "react/Button.tsx" },
        { projectRoot: sourceFixtureRoot, provider, collectionsRootDir: join(projectRoot, ".reactfig", "collections") }
      )
    ).rejects.toThrow(CollectionStateError);
  });

  it("start_interactive_capture requires a url when starting a fresh collection", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "reactfig-interactive-"));
    const registry = makeSessionRegistry();
    await expect(
      startInteractiveCaptureTool({}, { projectRoot, attachBrowser: fakeAttachBrowser(), registerActiveSession: registry.registerActiveSession })
    ).rejects.toThrow(/`url` is required/);
  });

  it("start_interactive_capture can resume an existing, not-yet-finalized collection by id", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "reactfig-interactive-"));
    const registry = makeSessionRegistry();
    const first = await startInteractiveCaptureTool(
      { url: "http://localhost:3000" },
      { projectRoot, attachBrowser: fakeAttachBrowser(), registerActiveSession: registry.registerActiveSession }
    );

    const resumed = await startInteractiveCaptureTool(
      { collectionId: first.collectionId },
      { projectRoot, attachBrowser: fakeAttachBrowser(), registerActiveSession: registry.registerActiveSession }
    );
    expect(resumed.collectionId).toBe(first.collectionId);
    expect(resumed.entryUrl).toBe("http://localhost:3000");
  });

  it("auto-prunes the active-session registry when the browser page closes without finalize_interactive_capture ever being called", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "reactfig-interactive-"));
    const registry = makeSessionRegistry();
    const fake = fakeAttachBrowserWithEvents();

    const started = await startInteractiveCaptureTool(
      { url: "http://localhost:3000" },
      { projectRoot, attachBrowser: fake.attachBrowser, registerActiveSession: registry.registerActiveSession, dropActiveSession: registry.dropActiveSession }
    );
    expect(registry.getActiveSession(started.collectionId)).toBeDefined();

    // Developer closed the browser tab by hand — no finalize_interactive_capture call ever happens.
    fake.fireClose();

    expect(registry.getActiveSession(started.collectionId)).toBeUndefined();
  });

  it("auto-prunes the active-session registry when the underlying browser disconnects (crash) rather than just the page closing", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "reactfig-interactive-"));
    const registry = makeSessionRegistry();
    const fake = fakeAttachBrowserWithEvents();

    const started = await startInteractiveCaptureTool(
      { url: "http://localhost:3000" },
      { projectRoot, attachBrowser: fake.attachBrowser, registerActiveSession: registry.registerActiveSession, dropActiveSession: registry.dropActiveSession }
    );

    fake.fireDisconnected();

    expect(registry.getActiveSession(started.collectionId)).toBeUndefined();
  });

  it("start_interactive_capture accepts an explicit viewport override", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "reactfig-interactive-"));
    const registry = makeSessionRegistry();
    let receivedViewport: { width: number; height: number } | undefined;
    const attachBrowser: StartInteractiveCaptureContext["attachBrowser"] = async (_session, options) => {
      receivedViewport = options.viewport;
      return { page: {}, close: async () => {} } as unknown as InteractiveBrowserHandle;
    };

    await startInteractiveCaptureTool(
      { url: "http://localhost:3000", viewport: { width: 390, height: 844 } },
      { projectRoot, attachBrowser, registerActiveSession: registry.registerActiveSession }
    );

    expect(receivedViewport).toEqual({ width: 390, height: 844 });
  });
});