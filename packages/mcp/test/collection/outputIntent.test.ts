import { describe, it, expect } from "vitest";
import { createManifest, addSelection, setCollectionOutputFormat, setSelectionOutputFormat } from "../../src/collection/collectionManifest.js";
import { resolveOutputFormat } from "../../src/collection/types.js";
import type { CollectionSelection } from "../../src/collection/types.js";

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

describe("Output Intent — resolveOutputFormat", () => {
  it("defaults to rfd for a manifest that predates Output Intent entirely (no `output` anywhere)", () => {
    const manifest = createManifest("col_1", "/project", "http://localhost:3000");
    const withSelection = addSelection(manifest, makeSelection());
    expect(resolveOutputFormat(withSelection)).toBe("rfd");
    expect(resolveOutputFormat(withSelection, "sel_001")).toBe("rfd");
  });

  it("persists and resolves a collection-level default", () => {
    const manifest = createManifest("col_1", "/project", "http://localhost:3000", undefined, "svg");
    expect(manifest.output).toEqual({ format: "svg" });
    expect(resolveOutputFormat(manifest)).toBe("svg");
  });

  it("setCollectionOutputFormat sets/clears the collection-level default", () => {
    const manifest = createManifest("col_1", "/project", "http://localhost:3000");
    const withDefault = setCollectionOutputFormat(manifest, "json");
    expect(resolveOutputFormat(withDefault)).toBe("json");
    const cleared = setCollectionOutputFormat(withDefault, undefined);
    expect(resolveOutputFormat(cleared)).toBe("rfd");
  });

  it("a selection-level override wins over the collection default", () => {
    let manifest = createManifest("col_1", "/project", "http://localhost:3000", undefined, "rfd");
    manifest = addSelection(manifest, makeSelection());
    manifest = setSelectionOutputFormat(manifest, "sel_001", "html");
    expect(resolveOutputFormat(manifest, "sel_001")).toBe("html");
    // A second, unrelated selection with no override still falls back to the collection default.
    manifest = addSelection(manifest, makeSelection({ selectionId: "sel_002", order: 2 }));
    expect(resolveOutputFormat(manifest, "sel_002")).toBe("rfd");
  });

  it("clearing a selection override falls back to the collection default", () => {
    let manifest = createManifest("col_1", "/project", "http://localhost:3000", undefined, "json");
    manifest = addSelection(manifest, makeSelection());
    manifest = setSelectionOutputFormat(manifest, "sel_001", "svg");
    expect(resolveOutputFormat(manifest, "sel_001")).toBe("svg");
    manifest = setSelectionOutputFormat(manifest, "sel_001", undefined);
    expect(resolveOutputFormat(manifest, "sel_001")).toBe("json");
  });
});
