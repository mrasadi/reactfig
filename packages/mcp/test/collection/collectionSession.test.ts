import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawDomSnapshot } from "@reactfig/analyzer";
import { CollectionSession } from "../../src/collection/collectionSession.js";
import { CollectionStateError } from "../../src/collection/collectionManifest.js";
import { activeSelections } from "../../src/collection/types.js";

let projectRoot: string;
afterEach(() => {
  if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
});

function fakeRawSnapshot(overrides: Partial<RawDomSnapshot> = {}): RawDomSnapshot {
  return {
    tag: "div",
    attributes: { className: "session-card" },
    textContent: "3 sessions",
    rect: { x: 10, y: 20, width: 320, height: 140 },
    computedStyle: { display: "flex" },
    naturalWidth: null,
    naturalHeight: null,
    componentPath: ["Dashboard", "SessionCard"],
    children: [],
    ...overrides,
  };
}

function fakeCaptureInput(overrides: Partial<Parameters<CollectionSession["captureSelection"]>[0]> = {}) {
  return {
    url: "http://localhost:3000/dashboard",
    pageTitle: "Dashboard",
    componentPath: ["Dashboard", "SessionCard"],
    selector: "#sc-1",
    tag: "div",
    rect: { x: 10, y: 20, width: 320, height: 140 },
    rawSnapshot: fakeRawSnapshot(),
    screenshot: Buffer.from("fake-png-bytes"),
    ...overrides,
  };
}

describe("CollectionSession", () => {
  it("create() persists a fresh manifest to disk immediately", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "reactfig-collection-"));
    const session = await CollectionSession.create({ projectRoot, entryUrl: "http://localhost:3000" });
    expect(session.collectionId).toMatch(/^col_[0-9a-f]{12}$/);
    expect(existsSync(join(session.dir, "manifest.json"))).toBe(true);
    expect(session.getManifest().status).toBe("created");
  });

  it("captureSelection persists evidence.json and screenshot.png and adds a 'captured' entry to the manifest", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "reactfig-collection-"));
    const session = await CollectionSession.create({ projectRoot, entryUrl: "http://localhost:3000" });

    const manifest = await session.captureSelection(fakeCaptureInput());
    expect(manifest.status).toBe("collecting");
    const [selection] = manifest.selections;
    expect(selection.status).toBe("captured");
    expect(selection.componentPath).toEqual(["Dashboard", "SessionCard"]);

    const evidenceOnDisk = JSON.parse(readFileSync(join(session.dir, selection.evidencePath), "utf8"));
    expect(evidenceOnDisk.tag).toBe("div");
    expect(existsSync(join(session.dir, selection.screenshotPath))).toBe(true);
    expect(readFileSync(join(session.dir, selection.screenshotPath))).toEqual(Buffer.from("fake-png-bytes"));
  });

  it("multiple selections across multiple pages all persist independently, in capture order", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "reactfig-collection-"));
    const session = await CollectionSession.create({ projectRoot, entryUrl: "http://localhost:3000" });

    await session.captureSelection(fakeCaptureInput({ url: "http://localhost:3000/dashboard", componentPath: ["Dashboard", "StatCard"] }));
    await session.captureSelection(fakeCaptureInput({ url: "http://localhost:3000/dashboard", componentPath: ["Dashboard", "SessionCard"] }));
    const manifest = await session.captureSelection(fakeCaptureInput({ url: "http://localhost:3000/speaking", componentPath: ["Speaking", "QuestionPanel"] }));

    const active = activeSelections(manifest);
    expect(active.map((s) => s.selectionId)).toEqual(["sel_001", "sel_002", "sel_003"]);
    expect(new Set(active.map((s) => s.url)).size).toBe(2);
  });

  it("remove() marks a selection removed without deleting its evidence files", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "reactfig-collection-"));
    const session = await CollectionSession.create({ projectRoot, entryUrl: "http://localhost:3000" });
    const captured = await session.captureSelection(fakeCaptureInput());
    const [selection] = captured.selections;

    const manifest = await session.remove(selection.selectionId);
    expect(manifest.selections[0].status).toBe("removed");
    expect(activeSelections(manifest)).toEqual([]);
    // Evidence is kept on disk even though the selection is excluded from
    // finalization — see docs/architecture.md, "removal marks, never deletes".
    expect(existsSync(join(session.dir, selection.evidencePath))).toBe(true);
  });

  it("finalize() transitions created/collecting straight through finalizing to completed", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "reactfig-collection-"));
    const session = await CollectionSession.create({ projectRoot, entryUrl: "http://localhost:3000" });
    await session.captureSelection(fakeCaptureInput());

    const manifest = await session.finalize();
    expect(manifest.status).toBe("completed");
    expect(manifest.finalizedAt).not.toBeNull();
  });

  it("rejects capturing a new selection once finalized", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "reactfig-collection-"));
    const session = await CollectionSession.create({ projectRoot, entryUrl: "http://localhost:3000" });
    await session.finalize();
    await expect(session.captureSelection(fakeCaptureInput())).rejects.toThrow(CollectionStateError);
  });

  it("resume() reopens a collection from disk in a brand new CollectionSession instance — simulating a process restart", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "reactfig-collection-"));
    const original = await CollectionSession.create({ projectRoot, entryUrl: "http://localhost:3000" });
    await original.captureSelection(fakeCaptureInput());
    await original.captureSelection(fakeCaptureInput({ selector: "#sc-2" }));

    // A fresh instance, as if a new process opened this collection back up
    // with nothing carried over except the collectionId — see
    // CollectionSession.resume's own doc comment.
    const resumed = await CollectionSession.resume({ projectRoot, collectionId: original.collectionId });
    expect(activeSelections(resumed.getManifest())).toHaveLength(2);

    // The resumed session can keep collecting exactly as if it were the
    // same process — no selections are lost, and new ones append cleanly.
    const manifest = await resumed.captureSelection(fakeCaptureInput({ selector: "#sc-3" }));
    expect(activeSelections(manifest)).toHaveLength(3);
    expect(activeSelections(manifest)[2].selectionId).toBe("sel_003");
  });

  it("resume() throws a clear error for an unknown collectionId", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "reactfig-collection-"));
    await expect(CollectionSession.resume({ projectRoot, collectionId: "col_does_not_exist" })).rejects.toThrow(/No interactive capture collection/);
  });

  it("refresh() picks up manifest changes written by a different CollectionSession instance pointed at the same directory", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "reactfig-collection-"));
    const writer = await CollectionSession.create({ projectRoot, entryUrl: "http://localhost:3000" });
    const reader = await CollectionSession.resume({ projectRoot, collectionId: writer.collectionId });

    await writer.captureSelection(fakeCaptureInput());
    expect(activeSelections(reader.getManifest())).toHaveLength(0); // stale, not yet refreshed

    await reader.refresh();
    expect(activeSelections(reader.getManifest())).toHaveLength(1);
  });
});
