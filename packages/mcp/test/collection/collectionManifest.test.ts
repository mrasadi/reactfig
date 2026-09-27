import { describe, it, expect } from "vitest";
import {
  createManifest,
  addSelection,
  updateSelection,
  removeSelection,
  beginCollecting,
  beginFinalize,
  completeFinalize,
  CollectionStateError,
} from "../../src/collection/collectionManifest.js";
import type { CollectionSelection } from "../../src/collection/types.js";
import { activeSelections } from "../../src/collection/types.js";

function makeSelection(overrides: Partial<CollectionSelection> = {}): CollectionSelection {
  return {
    selectionId: "sel_001",
    order: 1,
    status: "captured",
    url: "http://localhost:3000/dashboard",
    pageTitle: "Dashboard",
    componentPath: ["Dashboard", "SessionCard"],
    selector: "#sc-1",
    tag: "div",
    rect: { x: 0, y: 0, width: 100, height: 50 },
    capturedAt: "2026-01-01T00:00:00.000Z",
    evidencePath: "selections/sel_001/evidence.json",
    screenshotPath: "selections/sel_001/screenshot.png",
    ...overrides,
  };
}

describe("collection manifest lifecycle", () => {
  it("starts in status 'created'", () => {
    const manifest = createManifest("col_abc", "/project", "http://localhost:3000");
    expect(manifest.status).toBe("created");
    expect(manifest.selections).toEqual([]);
    expect(manifest.finalizedAt).toBeNull();
  });

  it("promotes 'created' to 'collecting' when the first selection is added", () => {
    let manifest = createManifest("col_abc", "/project", "http://localhost:3000");
    manifest = addSelection(manifest, makeSelection());
    expect(manifest.status).toBe("collecting");
    expect(manifest.selections).toHaveLength(1);
  });

  it("beginCollecting is idempotent once already past 'created'", () => {
    let manifest = createManifest("col_abc", "/project", "http://localhost:3000");
    manifest = beginCollecting(manifest);
    manifest = beginCollecting(manifest);
    expect(manifest.status).toBe("collecting");
  });

  it("removeSelection marks the entry removed rather than deleting it", () => {
    let manifest = createManifest("col_abc", "/project", "http://localhost:3000");
    manifest = addSelection(manifest, makeSelection());
    manifest = removeSelection(manifest, "sel_001");
    expect(manifest.selections).toHaveLength(1);
    expect(manifest.selections[0].status).toBe("removed");
    expect(activeSelections(manifest)).toEqual([]);
  });

  it("updateSelection throws a CollectionStateError for an unknown selectionId", () => {
    const manifest = createManifest("col_abc", "/project", "http://localhost:3000");
    expect(() => updateSelection(manifest, "sel_999", { status: "removed" })).toThrow(CollectionStateError);
  });

  it("multiple pages/selections all belong to one manifest, preserved in capture order", () => {
    let manifest = createManifest("col_abc", "/project", "http://localhost:3000");
    manifest = addSelection(manifest, makeSelection({ selectionId: "sel_001", order: 1, url: "http://localhost:3000/a" }));
    manifest = addSelection(manifest, makeSelection({ selectionId: "sel_002", order: 2, url: "http://localhost:3000/a" }));
    manifest = addSelection(manifest, makeSelection({ selectionId: "sel_003", order: 3, url: "http://localhost:3000/b" }));
    expect(activeSelections(manifest).map((s) => s.selectionId)).toEqual(["sel_001", "sel_002", "sel_003"]);
    expect(new Set(activeSelections(manifest).map((s) => s.url)).size).toBe(2);
  });

  it("does NOT deduplicate two selections with the identical url+selector — they may represent different application states", () => {
    let manifest = createManifest("col_abc", "/project", "http://localhost:3000");
    manifest = addSelection(manifest, makeSelection({ selectionId: "sel_001", order: 1 }));
    manifest = addSelection(manifest, makeSelection({ selectionId: "sel_002", order: 2 }));
    expect(activeSelections(manifest)).toHaveLength(2);
  });

  it("the full lifecycle: created -> collecting -> finalizing -> completed", () => {
    let manifest = createManifest("col_abc", "/project", "http://localhost:3000");
    manifest = addSelection(manifest, makeSelection());
    expect(manifest.status).toBe("collecting");
    manifest = beginFinalize(manifest);
    expect(manifest.status).toBe("finalizing");
    manifest = completeFinalize(manifest);
    expect(manifest.status).toBe("completed");
    expect(manifest.finalizedAt).not.toBeNull();
  });

  it("rejects adding a selection to an already-finalized collection", () => {
    let manifest = createManifest("col_abc", "/project", "http://localhost:3000");
    manifest = addSelection(manifest, makeSelection());
    manifest = beginFinalize(manifest);
    manifest = completeFinalize(manifest);
    expect(() => addSelection(manifest, makeSelection({ selectionId: "sel_002", order: 2 }))).toThrow(CollectionStateError);
  });

  it("rejects removing a selection from an already-finalized collection", () => {
    let manifest = createManifest("col_abc", "/project", "http://localhost:3000");
    manifest = addSelection(manifest, makeSelection());
    manifest = beginFinalize(manifest);
    manifest = completeFinalize(manifest);
    expect(() => removeSelection(manifest, "sel_001")).toThrow(CollectionStateError);
  });

  it("completeFinalize refuses to complete a collection that was never put into 'finalizing'", () => {
    const manifest = createManifest("col_abc", "/project", "http://localhost:3000");
    expect(() => completeFinalize(manifest)).toThrow(CollectionStateError);
  });

  it("completeFinalize is idempotent once already completed", () => {
    let manifest = createManifest("col_abc", "/project", "http://localhost:3000");
    manifest = beginFinalize(manifest);
    manifest = completeFinalize(manifest);
    const finalizedAt = manifest.finalizedAt;
    manifest = completeFinalize(manifest);
    expect(manifest.finalizedAt).toBe(finalizedAt);
  });
});
