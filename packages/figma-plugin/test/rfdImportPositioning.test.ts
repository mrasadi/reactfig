import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unpack } from "@reactfig/artifact";
import type { FakeNode } from "./fakeFigma/createFakeFigma.js";
import { renderDocument } from "../src/code/render/renderDocument.js";
import { createFakeFigma } from "./fakeFigma/createFakeFigma.js";

function fixtureBytes(name: string): Uint8Array {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return new Uint8Array(readFileSync(path));
}

interface IrNodeLike {
  type: string;
  name: string;
  bounds: { x: number; y: number; width: number; height: number };
  children?: IrNodeLike[];
}

/**
 * Recursively asserts that every rendered FakeNode's x/y equals
 * `relativePosition(irChild.bounds, irParent.bounds)` — i.e. that the
 * position the renderer computed (geometry.ts's own relativePosition,
 * always correct in isolation) actually STUCK, rather than being
 * silently discarded by Auto Layout (docs/adr/0031). Walks frame/group
 * children 1:1 by index (render order is a straightforward sequential
 * map — see renderChildrenInto); stops at text/shape/image/instance
 * leaves and does not descend into an instance's own mirrored children
 * (a separate, already-covered concern — see renderInstance/
 * applyInstanceOverrides — not what this bug is about).
 */
function assertPositionsMatch(irNode: IrNodeLike, figmaNode: FakeNode, parentBounds: { x: number; y: number }, path: string): void {
  const expectedX = irNode.bounds.x - parentBounds.x;
  const expectedY = irNode.bounds.y - parentBounds.y;
  expect(figmaNode.x, `${path}.x`).toBeCloseTo(expectedX, 1);
  expect(figmaNode.y, `${path}.y`).toBeCloseTo(expectedY, 1);

  if ((irNode.type === "frame" || irNode.type === "group") && irNode.children) {
    expect(figmaNode.children.length, `${path}.children.length`).toBe(irNode.children.length);
    irNode.children.forEach((childIr, i) => {
      assertPositionsMatch(childIr, figmaNode.children[i], irNode.bounds, `${path}/${childIr.name}`);
    });
  }
}

/** True if this IR node or any descendant uses Figma Auto Layout (`layout.mode !== "none"`) — used to assert the fixture actually exercises the bug's precondition, not just to assert positions blindly. */
function hasFlexDescendant(irNode: IrNodeLike & { layout?: { mode?: string } }): boolean {
  if (irNode.layout?.mode && irNode.layout.mode !== "none") return true;
  return (irNode.children ?? []).some((c) => hasFlexDescendant(c as IrNodeLike & { layout?: { mode?: string } }));
}

/**
 * Real, end-to-end reproduction of a reported bug: after importing an
 * RFD whose captured layout used nested CSS flexbox (mapped to nested
 * Figma Auto Layout frames — several with a near-zero captured bounding
 * box, e.g. a `display:contents` wrapper), children rendered displaced
 * from their correct position — visible immediately on import, but NOT
 * present after flattening (which discards the intermediate Auto Layout
 * frames' own flow control entirely, incidentally "fixing" the visual
 * symptom while destroying editability — exactly why the reporter didn't
 * want it as the actual fix). Root cause: Figma Auto Layout, once enabled
 * on a frame, computes and OWNS every non-"ABSOLUTE" child's position
 * itself (padding + itemSpacing + alignment) — a plain `child.x = ...`
 * assignment is silently ineffective for such a child (see @figma/
 * plugin-typings' own doc comment for `layoutPositioning`). Fixed in
 * geometry.ts's `placeInParent`, used by every render* function in
 * renderNode.ts — see docs/adr/0031 for the full investigation.
 */
describe("RFD → Figma import — nested Auto Layout child positioning (real reported bug, docs/adr/0031)", () => {
  it("the fixture actually exercises nested flex/Auto Layout (sanity check — a false-positive-proof test needs this precondition true)", async () => {
    const unpacked = await unpack(fixtureBytes("ClaudeNavigation.rfd"));
    const tabNav = unpacked.document.components.find((c) => c.name === "Tab Navigation");
    expect(tabNav?.kind).toBe("component");
    expect(hasFlexDescendant((tabNav as { root: IrNodeLike & { layout?: { mode?: string } } }).root)).toBe(true);
  });

  it("every nested frame/group/text/shape/image child renders at its correct captured position immediately after import — not just after flattening", async () => {
    const unpacked = await unpack(fixtureBytes("ClaudeNavigation.rfd"));
    const { figma, currentPage } = createFakeFigma();
    const result = await renderDocument(unpacked.document, unpacked.assets, unpacked.assetMimeTypes ?? {}, figma);

    const importRoot = currentPage.children.find((c) => c.name.startsWith("ReactFig: "))!;
    const tabNavNode = importRoot.children.find((c) => c.type === "COMPONENT" && c.name === "Tab Navigation")!;
    expect(tabNavNode, "rendered 'Tab Navigation' component not found").toBeDefined();

    const tabNavIr = unpacked.document.components.find((c) => c.name === "Tab Navigation") as unknown as { root: IrNodeLike };
    expect(tabNavIr.root.children).toBeDefined();

    tabNavIr.root.children!.forEach((childIr, i) => {
      assertPositionsMatch(childIr, tabNavNode.children[i], tabNavIr.root.bounds, `TabNavigation/${childIr.name}`);
    });

    // No warnings from this render — a position bug wouldn't surface as
    // one (silently wrong data, not an error), but this at least proves
    // nothing else about the fixture is degraded/unrenderable.
    expect(result.warnings.filter((w) => w.includes("Tab Navigation"))).toEqual([]);
  });

  it("every Auto Layout child the renderer created is marked layoutPositioning: ABSOLUTE — the actual mechanism the fix relies on", async () => {
    const unpacked = await unpack(fixtureBytes("ClaudeNavigation.rfd"));
    const { figma, currentPage } = createFakeFigma();
    await renderDocument(unpacked.document, unpacked.assets, unpacked.assetMimeTypes ?? {}, figma);

    const importRoot = currentPage.children.find((c) => c.name.startsWith("ReactFig: "))!;
    const tabNavNode = importRoot.children.find((c) => c.type === "COMPONENT" && c.name === "Tab Navigation")!;

    function collectAutoLayoutChildren(node: FakeNode, out: FakeNode[] = []): FakeNode[] {
      const isAutoLayoutParent = Boolean(node.layoutMode) && node.layoutMode !== "NONE";
      for (const child of node.children) {
        if (isAutoLayoutParent) out.push(child);
        collectAutoLayoutChildren(child, out);
      }
      return out;
    }

    const autoLayoutChildren = collectAutoLayoutChildren(tabNavNode);
    expect(autoLayoutChildren.length).toBeGreaterThan(0); // sanity: the fixture really does have Auto Layout parents with children
    for (const child of autoLayoutChildren) {
      expect(child.layoutPositioning, `"${child.name}" (type ${child.type}) should be ABSOLUTE`).toBe("ABSOLUTE");
    }
  });

  it("a frame resized down to safeSize's near-zero floor (a captured zero-bounds wrapper) does not clip its real, correctly-positioned children", async () => {
    const unpacked = await unpack(fixtureBytes("ClaudeNavigation.rfd"));
    const { figma, currentPage } = createFakeFigma();
    await renderDocument(unpacked.document, unpacked.assets, unpacked.assetMimeTypes ?? {}, figma);

    const importRoot = currentPage.children.find((c) => c.name.startsWith("ReactFig: "))!;
    const tabNavNode = importRoot.children.find((c) => c.type === "COMPONENT" && c.name === "Tab Navigation")!;

    function collectAllFrames(node: FakeNode, out: FakeNode[] = []): FakeNode[] {
      if (node.type === "FRAME") out.push(node);
      for (const child of node.children) collectAllFrames(child, out);
      return out;
    }

    const tinyFramesWithChildren = collectAllFrames(tabNavNode).filter((f) => f.width <= 0.01 && f.height <= 0.01 && f.children.length > 0);
    expect(tinyFramesWithChildren.length).toBeGreaterThan(0); // sanity: this fixture really has this exact shape (e.g. a `display:contents` wrapper)
    for (const frame of tinyFramesWithChildren) {
      expect(frame.clipsContent, `"${frame.name}" (${frame.width}x${frame.height}) must not clip its real children`).toBe(false);
    }
  });
});
