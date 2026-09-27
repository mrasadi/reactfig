import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { diffDesignDocuments, formatDesignIrDiff } from "../src/diff.js";
import type { ComponentDef, ComponentSet, DesignDocument, FrameNode, Node, TextNode } from "../src/types.js";

function loadFixture(name: string): DesignDocument {
  const path = fileURLToPath(new URL(`../../artifact/test/fixtures/design-ir/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8"));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function findNode(node: Node, id: string): Node | undefined {
  if (node.id === id) return node;
  if (node.type === "frame" || node.type === "group") {
    for (const child of node.children) {
      const found = findNode(child, id);
      if (found) return found;
    }
  }
  return undefined;
}

function rootOf(comp: ComponentDef | ComponentSet): Node {
  return comp.kind === "component" ? comp.root : comp.variants[0].root;
}

describe("diffDesignDocuments", () => {
  it("reports no differences for an identical document, including after a clone", () => {
    const doc = loadFixture("session-card");
    const result = diffDesignDocuments(doc, clone(doc));
    expect(result.identical).toBe(true);
    expect(result.entries).toEqual([]);
    expect(result.summary).toEqual({});
  });

  it("ignores meta.generatedAt — the one field that legitimately differs on every generation", () => {
    const before = loadFixture("session-card");
    const after = clone(before);
    after.meta.generatedAt = "2099-01-01T00:00:00.000Z";
    const result = diffDesignDocuments(before, after);
    expect(result.identical).toBe(true);
  });

  it("detects a bounds change as a bounds-category entry, not a generic structure change", () => {
    const before = loadFixture("session-card");
    const after = clone(before);
    const comp = after.components.find((c) => c.id === "comp_sessioncard")! as ComponentDef;
    (comp.root as FrameNode).bounds.width = comp.root.bounds.width + 2;

    const result = diffDesignDocuments(before, after);
    const widthEntry = result.entries.find((e) => e.path.endsWith("/bounds/width"));
    expect(widthEntry).toBeDefined();
    expect(widthEntry!.category).toBe("bounds");
    expect(widthEntry!.severity).toBe("minor");
    expect(widthEntry!.before).toBe(before.components.find((c) => c.id === "comp_sessioncard")!.kind === "component" ? (before.components.find((c) => c.id === "comp_sessioncard") as ComponentDef).root.bounds.width : undefined);
  });

  it("detects a typography change (fontWeight) under the typography category", () => {
    const before = loadFixture("session-card");
    const after = clone(before);
    const comp = after.components.find((c) => c.id === "comp_sessioncard")! as ComponentDef;
    const textNode = findTextNode(comp.root);
    expect(textNode).toBeDefined();
    const originalWeight = textNode!.typography.fontWeight;
    textNode!.typography.fontWeight = originalWeight === 700 ? 600 : 700;

    const result = diffDesignDocuments(before, after);
    const entry = result.entries.find((e) => e.path.endsWith("/typography/fontWeight"));
    expect(entry).toBeDefined();
    expect(entry!.category).toBe("typography");
    expect(entry!.before).toBe(originalWeight);
  });

  it("detects a fill/color change under the fills category", () => {
    const before = loadFixture("session-card");
    const after = clone(before);
    const comp = after.components.find((c) => c.id === "comp_sessioncard")! as ComponentDef;
    const frame = comp.root as FrameNode;
    frame.fills = [{ type: "solid", color: { r: 1, g: 0, b: 0, a: 1 } }];

    const result = diffDesignDocuments(before, after);
    const entry = result.entries.find((e) => e.path === "components/comp_sessioncard/root/fills");
    expect(entry).toBeDefined();
    expect(entry!.category).toBe("fills");
    expect(entry!.severity).toBe("minor");
  });

  it("reports an added node as a major structure entry, matched by id not index", () => {
    const before = loadFixture("session-card");
    const after = clone(before);
    const comp = after.components.find((c) => c.id === "comp_sessioncard")! as ComponentDef;
    const frame = comp.root as FrameNode;
    const newNode: Node = {
      id: "node_new_score",
      name: "session-card-score",
      type: "text",
      bounds: { x: 0, y: 0, width: 40, height: 16 },
      characters: "95",
      typography: { fontFamily: "Inter", fontWeight: 600, fontSize: 12 },
    };
    frame.children = [newNode, ...frame.children];

    const result = diffDesignDocuments(before, after);
    const addedEntries = result.entries.filter((e) => e.change === "added" && e.category === "structure");
    expect(addedEntries.some((e) => e.path.endsWith("node_new_score"))).toBe(true);
    expect(addedEntries.find((e) => e.path.endsWith("node_new_score"))!.severity).toBe("major");

    // Reordering the untouched siblings around the new node must not
    // ALSO produce spurious remove/add entries for them.
    const spuriousRemovals = result.entries.filter((e) => e.change === "removed" && e.category === "structure");
    expect(spuriousRemovals.length).toBe(0);
  });

  it("reports a removed node as a major structure entry", () => {
    const before = loadFixture("session-card");
    const after = clone(before);
    const comp = after.components.find((c) => c.id === "comp_sessioncard")! as ComponentDef;
    const frame = comp.root as FrameNode;
    const removedChild = frame.children[0];
    frame.children = frame.children.slice(1);

    const result = diffDesignDocuments(before, after);
    const entry = result.entries.find((e) => e.change === "removed" && e.path.endsWith(removedChild.id));
    expect(entry).toBeDefined();
    expect(entry!.category).toBe("structure");
    expect(entry!.severity).toBe("major");
  });

  it("matches a node by id across a reorder instead of reporting it removed+added, and flags the reorder itself as a minor structure entry", () => {
    const before = loadFixture("session-card");
    const after = clone(before);
    const comp = after.components.find((c) => c.id === "comp_sessioncard")! as ComponentDef;
    const frame = comp.root as FrameNode;
    expect(frame.children.length).toBeGreaterThan(1);
    frame.children = [...frame.children].reverse();

    const result = diffDesignDocuments(before, after);
    const addRemove = result.entries.filter((e) => e.change === "added" || e.change === "removed");
    expect(addRemove).toEqual([]);
    const orderEntry = result.entries.find((e) => e.path.endsWith("/children (order)"));
    expect(orderEntry).toBeDefined();
    expect(orderEntry!.severity).toBe("minor");
  });

  it("detects a componentRef change (instance repointed) under the instances category as major", () => {
    const before = loadFixture("session-card");
    const after = clone(before);
    const comp = after.components.find((c) => c.id === "comp_sessioncard")! as ComponentDef;
    const instance = findInstanceNode(comp.root);
    expect(instance).toBeDefined();
    const before_ref = clone(instance!.componentRef);
    instance!.componentRef = { kind: "component", componentId: "comp_something_else" };

    const result = diffDesignDocuments(before, after);
    const entry = result.entries.find((e) => e.path.endsWith("/componentRef"));
    expect(entry).toBeDefined();
    expect(entry!.category).toBe("instances");
    expect(entry!.severity).toBe("major");
    expect(entry!.before).toEqual(before_ref);
  });

  it("detects an added component (whole new definition) as a major structure entry", () => {
    const before = loadFixture("session-card");
    const after = clone(before);
    const extra: ComponentDef = {
      kind: "component",
      id: "comp_new_thing",
      name: "NewThing",
      root: { id: "node_new_thing_root", name: "NewThing", type: "frame", bounds: { x: 0, y: 0, width: 10, height: 10 }, children: [] },
    };
    after.components = [...after.components, extra];

    const result = diffDesignDocuments(before, after);
    const entry = result.entries.find((e) => e.path === "components/comp_new_thing");
    expect(entry).toBeDefined();
    expect(entry!.change).toBe("added");
    expect(entry!.severity).toBe("major");
  });

  it("detects a variant axis change on a ComponentSet under the variants category", () => {
    const button = loadFixture("button");
    const before = button;
    const after = clone(button);
    const buttonSet = after.components.find((c) => c.kind === "componentSet")! as ComponentSet;
    buttonSet.variantProperties = buttonSet.variantProperties.map((axis) =>
      axis.name === "variant" ? { ...axis, values: [...axis.values, "danger"] } : axis
    );

    const result = diffDesignDocuments(before, after);
    const entry = result.entries.find((e) => e.path.endsWith("/variantProperties"));
    expect(entry).toBeDefined();
    expect(entry!.category).toBe("variants");
  });

  it("detects an asset added/changed under the assets category", () => {
    const before = loadFixture("session-card");
    const after = clone(before);
    after.assets = [...after.assets, { id: "asset_new", path: "assets/new.png", mimeType: "image/png", width: 10, height: 10 }];

    const result = diffDesignDocuments(before, after);
    const entry = result.entries.find((e) => e.path === "assets/asset_new");
    expect(entry).toBeDefined();
    expect(entry!.change).toBe("added");
    expect(entry!.category).toBe("assets");
  });

  it("detects a page change under the pages category", () => {
    const before = loadFixture("session-card");
    const after = clone(before);
    after.pages = after.pages.map((p) => ({ ...p, name: `${p.name} (renamed)` }));

    const result = diffDesignDocuments(before, after);
    const entry = result.entries.find((e) => e.category === "pages" && e.path.endsWith("/name"));
    expect(entry).toBeDefined();
    expect(entry!.change).toBe("changed");
  });

  it("produces deterministic output — running the diff twice on the same inputs gives byte-identical entries", () => {
    const before = loadFixture("session-card");
    const after = clone(before);
    const comp = after.components.find((c) => c.id === "comp_sessioncard")! as ComponentDef;
    (comp.root as FrameNode).bounds.width += 2;

    const first = diffDesignDocuments(before, after);
    const second = diffDesignDocuments(before, after);
    expect(JSON.stringify(first.entries)).toBe(JSON.stringify(second.entries));
  });

  it("formatDesignIrDiff renders a readable category-grouped report", () => {
    const before = loadFixture("session-card");
    const after = clone(before);
    const comp = after.components.find((c) => c.id === "comp_sessioncard")! as ComponentDef;
    (comp.root as FrameNode).bounds.width += 2;

    const result = diffDesignDocuments(before, after);
    const report = formatDesignIrDiff(result, "SessionCard");
    expect(report).toContain("SessionCard");
    expect(report).toContain("BOUNDS");
    expect(report).toMatch(/\u2192/);
  });

  it("formatDesignIrDiff reports '(no semantic differences)' for an identical pair", () => {
    const doc = loadFixture("session-card");
    const result = diffDesignDocuments(doc, clone(doc));
    expect(formatDesignIrDiff(result)).toContain("no semantic differences");
  });
});

function findTextNode(node: Node): TextNode | undefined {
  if (node.type === "text") return node;
  if (node.type === "frame" || node.type === "group") {
    for (const child of node.children) {
      const found = findTextNode(child);
      if (found) return found;
    }
  }
  return undefined;
}

function findInstanceNode(node: Node): Extract<Node, { type: "instance" }> | undefined {
  if (node.type === "instance") return node;
  if (node.type === "frame" || node.type === "group") {
    for (const child of node.children) {
      const found = findInstanceNode(child);
      if (found) return found;
    }
  }
  return undefined;
}
