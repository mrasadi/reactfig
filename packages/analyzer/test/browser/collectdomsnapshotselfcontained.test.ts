import { describe, it, expect } from "vitest";
import { collectDomSnapshot, COMPUTED_STYLE_PROPERTIES } from "../../src/browser/collectDomSnapshot.js";

/**
 * Regression test for a real production bug (Phase 8): Playwright's
 * `page.evaluate(fn, arg)` serializes `fn` via `fn.toString()` and
 * evaluates ONLY that source text inside the page's own JS context — it
 * does not carry along the enclosing module's closure. `collectDomSnapshot`
 * used to reference module-level `COMPUTED_STYLE_PROPERTIES` and several
 * sibling helper functions, which are invisible once only the function's
 * own source crosses that boundary — producing a real
 * "COMPUTED_STYLE_PROPERTIES is not defined" ReferenceError in an actual
 * browser, never caught by any test here because no test previously
 * reproduced the actual serialization boundary.
 *
 * This test reproduces that boundary directly: it extracts
 * `collectDomSnapshot.toString()` and reconstructs the function via
 * `new Function`, in a scope that has access to NOTHING from this module
 * or this test file except the three parameters explicitly passed in
 * (`document`, `getComputedStyle`, `Node`) — exactly what a real browser
 * page provides and nothing else. If `collectDomSnapshot` ever again
 * references an identifier declared outside its own body, this test
 * fails with the same ReferenceError a real browser would throw.
 */

interface FakeElement {
  tagName: string;
  id: string;
  className: string;
  attributes: Record<string, string>;
  childNodes: Array<{ nodeType: number; textContent: string | null }>;
  children: FakeElement[];
  rect: { x: number; y: number; width: number; height: number };
  naturalWidth?: number;
  naturalHeight?: number;
  outerHTML?: string;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
}

function makeFakeElement(config: {
  tag: string;
  id?: string;
  className?: string;
  text?: string;
  attributes?: Record<string, string>;
  rect?: { x: number; y: number; width: number; height: number };
  children?: FakeElement[];
  outerHTML?: string;
}): FakeElement {
  const attrs = config.attributes ?? {};
  return {
    tagName: config.tag.toUpperCase(),
    id: config.id ?? "",
    className: config.className ?? "",
    attributes: attrs,
    childNodes: config.text ? [{ nodeType: 3, textContent: config.text }] : [],
    children: config.children ?? [],
    rect: config.rect ?? { x: 0, y: 0, width: 100, height: 50 },
    outerHTML: config.outerHTML,
    getAttribute(name: string) {
      return attrs[name] ?? null;
    },
    getBoundingClientRect() {
      return this.rect;
    },
  };
}

function buildIsolatedCollectDomSnapshot(): (args: { selector: string; rootComponentName?: string }) => unknown {
  const source = collectDomSnapshot.toString();
  // eslint-disable-next-line no-new-func -- intentional: reproduces the real page.evaluate serialization boundary
  const factory = new Function("document", "getComputedStyle", "Node", `return (${source});`);

  const root = makeFakeElement({
    tag: "div",
    className: "card",
    rect: { x: 10, y: 20, width: 320, height: 220 },
    children: [makeFakeElement({ tag: "span", text: "Hello", rect: { x: 20, y: 30, width: 80, height: 20 } })],
  });

  const fakeDocument = {
    querySelector: (selector: string) => (selector === "#root" || selector === ".card" ? root : null),
  };

  const fakeGetComputedStyle = (_el: FakeElement) => ({
    getPropertyValue: (prop: string) => (prop === "display" ? "flex" : ""),
  });

  const fakeNode = { TEXT_NODE: 3 };

  return factory(fakeDocument, fakeGetComputedStyle, fakeNode) as (args: {
    selector: string;
    rootComponentName?: string;
  }) => unknown;
}

describe("collectDomSnapshot — self-contained across the page.evaluate serialization boundary", () => {
  it("runs without a ReferenceError when evaluated with access to nothing but explicit browser globals", () => {
    const isolated = buildIsolatedCollectDomSnapshot();
    expect(() => isolated({ selector: ".card" })).not.toThrow();
  });

  it("produces a correct snapshot when run in isolation — proving computedStyleProperties, walk, and getComponentPath are all genuinely self-contained", () => {
    const isolated = buildIsolatedCollectDomSnapshot();
    const result = isolated({ selector: ".card" }) as {
      tag: string;
      computedStyle: Record<string, string>;
      children: Array<{ tag: string; textContent: string | null }>;
      componentPath: string[] | null;
    };

    expect(result.tag).toBe("div");
    expect(result.computedStyle.display).toBe("flex");
    // Every property in the module-level list must have been captured —
    // proves the inline copy inside the function body is complete, not a
    // stale subset of the exported list.
    expect(Object.keys(result.computedStyle).sort()).toEqual([...COMPUTED_STYLE_PROPERTIES].sort());
    expect(result.children).toHaveLength(1);
    expect(result.children[0].tag).toBe("span");
    expect(result.children[0].textContent).toBe("Hello");
    // No fiber key on this fake element — componentPath must degrade to
    // null gracefully, not throw.
    expect(result.componentPath).toBeNull();
  });

  it("returns null (not a throw) when the selector matches nothing", () => {
    const isolated = buildIsolatedCollectDomSnapshot();
    expect(isolated({ selector: "#does-not-exist" })).toBeNull();
  });

  it("resolves the real component name through React.memo and React.forwardRef wrappers, not just plain function components", () => {
    // React.memo(Component) produces { $$typeof, type: Component, compare }
    // and React.forwardRef((props, ref) => ...) produces
    // { $$typeof, render: fn } — neither wrapper object itself typically
    // has its own .displayName/.name, so componentDisplayName has to
    // unwrap them to find the actual component. This reproduces that
    // shape directly on a fake fiber, without needing a real browser/React.
    const source = collectDomSnapshot.toString();
    // eslint-disable-next-line no-new-func -- intentional: same serialization-boundary reproduction as buildIsolatedCollectDomSnapshot
    const factory = new Function("document", "getComputedStyle", "Node", `return (${source});`);

    const el = makeFakeElement({ tag: "span", text: "12", rect: { x: 0, y: 0, width: 50, height: 20 } }) as unknown as Record<string, unknown>;
    function MemoStatCard() {}
    const memoOwnerType = { $$typeof: Symbol.for("react.memo"), type: MemoStatCard };
    function ForwardRefBadgeRender() {}
    const forwardRefOwnerType = { $$typeof: Symbol.for("react.forward_ref"), render: ForwardRefBadgeRender };

    el.__reactFiber$test = {
      _debugOwner: {
        type: forwardRefOwnerType,
        _debugOwner: { type: memoOwnerType, _debugOwner: null },
      },
    };

    const fakeDocument = { querySelector: (selector: string) => (selector === "#el" ? el : null) };
    const fakeGetComputedStyle = () => ({ getPropertyValue: () => "" });
    const isolated = factory(fakeDocument, fakeGetComputedStyle, { TEXT_NODE: 3 }) as (args: { selector: string; rootComponentName?: string }) => { componentPath: string[] | null };

    const result = isolated({ selector: "#el" });
    // Outermost first: the memo-wrapped component, then the
    // forwardRef-wrapped one — both resolved to their real function
    // names, not "memo"/"forwardRef" or null.
    expect(result.componentPath).toEqual(["MemoStatCard", "ForwardRefBadgeRender"]);
  });

  describe("inline <svg> icon capture (docs/adr/0030)", () => {
    function buildIsolatedWithColor(colorValue: string) {
      const source = collectDomSnapshot.toString();
      // eslint-disable-next-line no-new-func -- intentional: same serialization-boundary reproduction as buildIsolatedCollectDomSnapshot
      const factory = new Function("document", "getComputedStyle", "Node", `return (${source});`);
      const fakeGetComputedStyle = (_el: FakeElement) => ({
        getPropertyValue: (prop: string) => (prop === "color" ? colorValue : ""),
      });
      const fakeNode = { TEXT_NODE: 3 };
      return { factory, fakeGetComputedStyle, fakeNode };
    }

    it("captures svgMarkup and does NOT walk into the svg's own internal children", () => {
      const svgEl = makeFakeElement({
        tag: "svg",
        attributes: { viewBox: "0 0 24 24" },
        outerHTML: '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"></path></svg>',
        rect: { x: 5, y: 5, width: 24, height: 24 },
        // A real browser DOM would have a <path> child element here too —
        // deliberately included to prove walk() skips descending into it
        // (children: [] in the RawDomSnapshot result) even though the fake
        // element itself technically has one.
        children: [makeFakeElement({ tag: "path" })],
      });
      const root = makeFakeElement({ tag: "div", className: "icon-wrap", children: [svgEl] });
      const { factory, fakeGetComputedStyle, fakeNode } = buildIsolatedWithColor("rgb(0, 0, 0)");
      const fakeDocument = { querySelector: (selector: string) => (selector === ".icon-wrap" ? root : null) };
      const isolated = factory(fakeDocument, fakeGetComputedStyle, fakeNode) as (args: { selector: string }) => {
        children: Array<{ tag: string; svgMarkup: string | null; children: unknown[] }>;
      };

      const result = isolated({ selector: ".icon-wrap" });
      expect(result.children).toHaveLength(1);
      const svgNode = result.children[0];
      expect(svgNode.tag).toBe("svg");
      expect(svgNode.svgMarkup).toContain("<path");
      // The <path> never became a nested RawDomSnapshot node of its own.
      expect(svgNode.children).toEqual([]);
    });

    it("resolves currentColor in the captured markup to the element's own computed color", () => {
      const svgEl = makeFakeElement({
        tag: "svg",
        attributes: { viewBox: "0 0 24 24" },
        outerHTML: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M0 0h24v24H0z"></path></svg>',
      });
      const root = makeFakeElement({ tag: "div", children: [svgEl] });
      const { factory, fakeGetComputedStyle, fakeNode } = buildIsolatedWithColor("rgb(95, 99, 104)");
      const fakeDocument = { querySelector: (selector: string) => (selector === "#root" ? root : null) };
      const isolated = factory(fakeDocument, fakeGetComputedStyle, fakeNode) as (args: { selector: string }) => {
        children: Array<{ svgMarkup: string | null }>;
      };

      const result = isolated({ selector: "#root" });
      expect(result.children[0].svgMarkup).toContain('fill="rgb(95, 99, 104)"');
      expect(result.children[0].svgMarkup).not.toContain("currentColor");
    });

    it("injects a viewBox synthesized from width/height attributes when the markup has none", () => {
      const svgEl = makeFakeElement({
        tag: "svg",
        attributes: { width: "24", height: "24" },
        outerHTML: '<svg width="24" height="24"><path d="M0 0h24v24H0z"></path></svg>',
      });
      const root = makeFakeElement({ tag: "div", children: [svgEl] });
      const { factory, fakeGetComputedStyle, fakeNode } = buildIsolatedWithColor("rgb(0,0,0)");
      const fakeDocument = { querySelector: (selector: string) => (selector === "#root" ? root : null) };
      const isolated = factory(fakeDocument, fakeGetComputedStyle, fakeNode) as (args: { selector: string }) => {
        children: Array<{ svgMarkup: string | null }>;
      };

      const result = isolated({ selector: "#root" });
      expect(result.children[0].svgMarkup).toContain('viewBox="0 0 24 24"');
    });

    it("leaves an svg's own existing viewBox untouched (no double-injection)", () => {
      const svgEl = makeFakeElement({
        tag: "svg",
        attributes: { viewBox: "0 0 32 32" },
        outerHTML: '<svg viewBox="0 0 32 32"><path d="M0 0h32v32H0z"></path></svg>',
      });
      const root = makeFakeElement({ tag: "div", children: [svgEl] });
      const { factory, fakeGetComputedStyle, fakeNode } = buildIsolatedWithColor("rgb(0,0,0)");
      const fakeDocument = { querySelector: (selector: string) => (selector === "#root" ? root : null) };
      const isolated = factory(fakeDocument, fakeGetComputedStyle, fakeNode) as (args: { selector: string }) => {
        children: Array<{ svgMarkup: string | null }>;
      };

      const result = isolated({ selector: "#root" });
      const markup = result.children[0].svgMarkup ?? "";
      expect(markup.match(/viewBox=/g)).toHaveLength(1);
      expect(markup).toContain('viewBox="0 0 32 32"');
    });

    it("svgMarkup is null for a non-svg element", () => {
      const root = makeFakeElement({ tag: "div" });
      const { factory, fakeGetComputedStyle, fakeNode } = buildIsolatedWithColor("rgb(0,0,0)");
      const fakeDocument = { querySelector: (selector: string) => (selector === "#root" ? root : null) };
      const isolated = factory(fakeDocument, fakeGetComputedStyle, fakeNode) as (args: { selector: string }) => {
        svgMarkup: string | null;
      };

      expect(isolated({ selector: "#root" }).svgMarkup).toBeNull();
    });
  });
});