import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollectionSession } from "../../src/collection/collectionSession.js";
import { createCollectionCapture } from "../../src/collection/collectionCapture.js";
import type { CaptureRequest } from "../../src/tools/generateDesignIr.js";
import type { RawDomSnapshot } from "@reactfig/analyzer";

let projectRoot: string;
afterEach(() => {
  if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
});

function fakeRawSnapshot(): RawDomSnapshot {
  return {
    tag: "div",
    attributes: { className: "session-card" },
    textContent: "3 sessions",
    rect: { x: 10, y: 20, width: 320, height: 140 },
    computedStyle: { display: "flex", "flex-direction": "column" },
    naturalWidth: null,
    naturalHeight: null,
    componentPath: ["Dashboard", "SessionCard"],
    children: [],
  };
}

function fakeCaptureRequest(overrides: Partial<CaptureRequest> = {}): CaptureRequest {
  return {
    url: "http://localhost:3000/dashboard",
    selector: "#sc-1",
    label: "default",
    viewport: { width: 1440, height: 900 },
    rootComponentName: "SessionCard",
    captureScreenshot: true,
    ...overrides,
  };
}

describe("createCollectionCapture — the Interactive Capture <-> generate_design_ir integration point", () => {
  it("builds a RenderCapture from a persisted selection's evidence, with no live browser involved", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "reactfig-collection-capture-"));
    const session = await CollectionSession.create({ projectRoot, entryUrl: "http://localhost:3000" });
    const manifest = await session.captureSelection({
      url: "http://localhost:3000/dashboard",
      pageTitle: "Dashboard",
      componentPath: ["Dashboard", "SessionCard"],
      selector: "#sc-1",
      tag: "div",
      rect: { x: 10, y: 20, width: 320, height: 140 },
      rawSnapshot: fakeRawSnapshot(),
      screenshot: Buffer.from("fake-png-bytes"),
    });
    const [selection] = manifest.selections;

    const capture = createCollectionCapture(selection, session.dir);
    const result = await capture(fakeCaptureRequest());

    expect(result.dom.tag).toBe("div");
    expect(result.dom.componentPath).toEqual(["Dashboard", "SessionCard"]);
    expect(result.dom.isComponentRoot).toBe(true);
    expect(result.capturedUrl).toBe("http://localhost:3000/dashboard");
    expect(result.matchCount).toBe(1);
    expect(result.screenshot).not.toBeNull();
    expect(result.screenshot!.width).toBe(320);
    expect(result.label).toBe(fakeCaptureRequest().label);
  });

  it("throws a clear, actionable error when the selection's evidence file is missing", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "reactfig-collection-capture-"));
    const session = await CollectionSession.create({ projectRoot, entryUrl: "http://localhost:3000" });
    const manifest = await session.captureSelection({
      url: "http://localhost:3000/dashboard",
      pageTitle: "Dashboard",
      componentPath: ["Dashboard", "SessionCard"],
      selector: "#sc-1",
      tag: "div",
      rect: { x: 10, y: 20, width: 320, height: 140 },
      rawSnapshot: fakeRawSnapshot(),
      screenshot: Buffer.from("fake-png-bytes"),
    });
    const [selection] = manifest.selections;

    const capture = createCollectionCapture({ ...selection, evidencePath: "selections/sel_999/evidence.json" }, session.dir);
    await expect(capture(fakeCaptureRequest())).rejects.toThrow(/evidence missing or unreadable/);
  });
});
