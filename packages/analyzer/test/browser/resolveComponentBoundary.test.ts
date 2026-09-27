import { describe, it, expect } from "vitest";
import { resolveComponentBoundary } from "../../src/browser/resolveComponentBoundary.js";

/**
 * Same serialization-boundary isolation technique as
 * findComponentInstances.test.ts / collectdomsnapshotselfcontained.test.ts:
 * reconstructs resolveComponentBoundary.toString() via `new Function` in a
 * scope with access to nothing but a fake `document` — exactly what
 * page.evaluate actually provides. Catches the same class of bug those
 * tests exist to catch: a reference to anything outside the function's
 * own body throws a ReferenceError in a real browser.
 */

interface FakeEl {
  tagName: string;
  id: string;
  children: FakeEl[];
  parentElement: FakeEl | null;
  textContent: string;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
  [fiberKey: string]: unknown;
}

function fiberFor(owners: string[]): { _debugOwner: unknown } {
  let chain: { type: { name: string }; _debugOwner: unknown } | null = null;
  for (const name of [...owners].reverse()) {
    chain = { type: { name }, _debugOwner: chain };
  }
  return { _debugOwner: chain };
}

let nextId = 0;

function makeEl(spec: { tag: string; owner?: string[]; text?: string; children?: FakeEl[] }): FakeEl {
  const el: FakeEl = {
    tagName: spec.tag.toUpperCase(),
    id: `el-${nextId++}`,
    children: spec.children ?? [],
    parentElement: null,
    textContent: spec.text ?? "",
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 40 }),
  };
  for (const child of el.children) child.parentElement = el;
  if (spec.owner) el.__reactFiber$test = fiberFor(spec.owner);
  return el;
}

/** Flattens the tree so the fake document can resolve `#id` selectors. */
function flatten(root: FakeEl): Map<string, FakeEl> {
  const map = new Map<string, FakeEl>();
  function visit(el: FakeEl) {
    map.set(`#${el.id}`, el);
    for (const child of el.children) visit(child);
  }
  visit(root);
  return map;
}

function run(body: FakeEl, selector: string, direction?: "root" | "parent" | "child") {
  const source = resolveComponentBoundary.toString();
  // eslint-disable-next-line no-new-func -- intentional: reproduces the real page.evaluate serialization boundary
  const factory = new Function("document", `return (${source});`);
  const byId = flatten(body);
  const fakeDocument = {
    body,
    querySelector: (sel: string) => byId.get(sel) ?? null,
  };
  const isolated = factory(fakeDocument) as typeof resolveComponentBoundary;
  return isolated({ selector, direction });
}

describe("resolveComponentBoundary — self-contained across the page.evaluate serialization boundary", () => {
  it("runs without a ReferenceError when evaluated with access to nothing but document", () => {
    const leaf = makeEl({ tag: "span", owner: ["Avatar", "SessionCard"] });
    const body = makeEl({ tag: "body", children: [leaf] });
    expect(() => run(body, `#${leaf.id}`)).not.toThrow();
  });

  it("returns null when the selector matches nothing", () => {
    const body = makeEl({ tag: "body" });
    expect(run(body, "#does-not-exist")).toBeNull();
  });

  it("walks a clicked leaf node outward to its component's own root (direction: root, default)", () => {
    const leaf = makeEl({ tag: "span", owner: ["SessionCard"], text: "3 sessions" });
    const wrapper = makeEl({ tag: "div", owner: ["SessionCard"], children: [leaf] });
    const body = makeEl({ tag: "body", children: [wrapper] });

    const result = run(body, `#${leaf.id}`);
    expect(result).not.toBeNull();
    expect(result!.selector).toBe(`#${wrapper.id}`);
    expect(result!.componentPath).toEqual(["SessionCard"]);
  });

  it("stops the outward walk at the boundary where the nearest owner actually changes", () => {
    const inner = makeEl({ tag: "img", owner: ["Avatar", "SessionCard"] });
    const avatarRoot = makeEl({ tag: "div", owner: ["Avatar", "SessionCard"], children: [inner] });
    const cardRoot = makeEl({ tag: "div", owner: ["SessionCard"], children: [avatarRoot] });
    const body = makeEl({ tag: "body", children: [cardRoot] });

    const result = run(body, `#${inner.id}`);
    expect(result!.selector).toBe(`#${avatarRoot.id}`);
    expect(result!.componentPath).toEqual(["SessionCard", "Avatar"]);
  });

  it("falls back gracefully to the clicked element itself when no React ownership info is available", () => {
    const plain = makeEl({ tag: "div" });
    const body = makeEl({ tag: "body", children: [plain] });

    const result = run(body, `#${plain.id}`);
    expect(result!.selector).toBe(`#${plain.id}`);
    expect(result!.componentPath).toBeNull();
  });

  it("direction: parent moves the boundary out to the next enclosing component instance", () => {
    const inner = makeEl({ tag: "img", owner: ["Avatar", "SessionCard"] });
    const avatarRoot = makeEl({ tag: "div", owner: ["Avatar", "SessionCard"], children: [inner] });
    const cardRoot = makeEl({ tag: "div", owner: ["SessionCard"], children: [avatarRoot] });
    const body = makeEl({ tag: "body", children: [cardRoot] });

    const result = run(body, `#${avatarRoot.id}`, "parent");
    expect(result!.selector).toBe(`#${cardRoot.id}`);
    expect(result!.componentPath).toEqual(["SessionCard"]);
  });

  it("direction: parent degrades gracefully to document.body when there is no further enclosing component", () => {
    const cardRoot = makeEl({ tag: "div", owner: ["SessionCard"] });
    const body = makeEl({ tag: "body", children: [cardRoot] });

    const result = run(body, `#${cardRoot.id}`, "parent");
    expect(result!.selector).toBe(`#${body.id}`);
  });

  it("direction: child moves the boundary in to the first nested component instance", () => {
    const avatarInner = makeEl({ tag: "img", owner: ["Avatar", "SessionCard"] });
    const avatarRoot = makeEl({ tag: "div", owner: ["Avatar", "SessionCard"], children: [avatarInner] });
    const cardRoot = makeEl({ tag: "div", owner: ["SessionCard"], children: [avatarRoot] });
    const body = makeEl({ tag: "body", children: [cardRoot] });

    const result = run(body, `#${cardRoot.id}`, "child");
    expect(result!.selector).toBe(`#${avatarRoot.id}`);
    expect(result!.componentPath).toEqual(["SessionCard", "Avatar"]);
  });

  it("direction: child is a no-op (returns the same boundary) for a leaf component with nothing nested inside it", () => {
    const leafOnly = makeEl({ tag: "span", owner: ["Badge"] });
    const cardRoot = makeEl({ tag: "div", owner: ["SessionCard"], children: [leafOnly] });
    const body = makeEl({ tag: "body", children: [cardRoot] });

    // leafOnly shares no distinct owner change beneath cardRoot other than itself
    const result = run(body, `#${leafOnly.id}`, "child");
    expect(result!.selector).toBe(`#${leafOnly.id}`);
  });

  describe("plain-DOM fallback — no React anywhere in the chain (docs/adr/0029, found capturing a real non-React page)", () => {
    it("direction: parent steps up exactly one DOM level instead of jumping to document.body", () => {
      const inner = makeEl({ tag: "div" });
      const styledAncestor = makeEl({ tag: "div", children: [inner] });
      const outerWrapper = makeEl({ tag: "div", children: [styledAncestor] });
      const body = makeEl({ tag: "body", children: [outerWrapper] });

      const result = run(body, `#${inner.id}`, "parent");
      expect(result!.selector).toBe(`#${styledAncestor.id}`);
      expect(result!.componentPath).toBeNull();
    });

    it("direction: parent from the outermost non-body element still lands on document.body (one real level up, not skipped)", () => {
      const onlyChild = makeEl({ tag: "div" });
      const body = makeEl({ tag: "body", children: [onlyChild] });

      const result = run(body, `#${onlyChild.id}`, "parent");
      expect(result!.selector).toBe(`#${body.id}`);
    });

    it("direction: child steps down exactly one DOM level (first element child) instead of finding nothing", () => {
      const grandchild = makeEl({ tag: "span" });
      const child = makeEl({ tag: "div", children: [grandchild] });
      const parent = makeEl({ tag: "div", children: [child] });
      const body = makeEl({ tag: "body", children: [parent] });

      const result = run(body, `#${parent.id}`, "child");
      expect(result!.selector).toBe(`#${child.id}`);
    });

    it("direction: child is a no-op for a plain leaf with no children at all", () => {
      const leaf = makeEl({ tag: "div" });
      const body = makeEl({ tag: "body", children: [leaf] });

      const result = run(body, `#${leaf.id}`, "child");
      expect(result!.selector).toBe(`#${leaf.id}`);
    });

    it("a mixed page (React island inside an otherwise plain DOM) still uses the owner-aware walk once ownership info exists anywhere in the chain", () => {
      // The exact real-world shape this must NOT regress: most of a page
      // has no React at all, but the selection itself (or an ancestor of
      // it) does — owner-walking should still apply there, only the
      // genuinely React-free case gets the plain-DOM fallback.
      const inner = makeEl({ tag: "img", owner: ["Avatar", "Widget"] });
      const widgetRoot = makeEl({ tag: "div", owner: ["Widget"], children: [inner] });
      const plainOuterWrapper = makeEl({ tag: "div", children: [widgetRoot] });
      const body = makeEl({ tag: "body", children: [plainOuterWrapper] });

      const result = run(body, `#${inner.id}`, "parent");
      expect(result!.selector).toBe(`#${widgetRoot.id}`);
      expect(result!.componentPath).toEqual(["Widget"]);
    });
  });
});
