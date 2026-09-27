import { describe, it, expect } from "vitest";
import { findComponentInstances } from "../../src/browser/findComponentInstances.js";

/**
 * Same serialization-boundary technique as
 * collectdomsnapshotselfcontained.test.ts: reconstructs
 * findComponentInstances.toString() via `new Function` in a scope with
 * access to nothing but explicit browser globals (`document`), exactly
 * what page.evaluate actually provides. If findComponentInstances ever
 * references an identifier declared outside its own body, this fails
 * with the same ReferenceError a real browser would throw.
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

/** Builds a fake `_debugOwner` chain. `owners` is innermost-first (the component that directly rendered this element, then its ancestors) — matching how a real fiber's `_debugOwner` climbs outward. */
function fiberFor(owners: string[]): { _debugOwner: unknown } {
  let chain: { type: { name: string }; _debugOwner: unknown } | null = null;
  for (const name of [...owners].reverse()) {
    chain = { type: { name }, _debugOwner: chain };
  }
  return { _debugOwner: chain };
}

function makeEl(spec: {
  tag: string;
  id?: string;
  text?: string;
  /** Innermost-first React ownership chain for this exact element, e.g. `["Avatar", "SessionCard"]` — omit for a plain DOM element with no fiber (matches a real host node with no attached React fiber info, or none captured). */
  owner?: string[];
  rect?: { x: number; y: number; width: number; height: number };
  children?: FakeEl[];
}): FakeEl {
  const el: FakeEl = {
    tagName: spec.tag.toUpperCase(),
    id: spec.id ?? "",
    children: spec.children ?? [],
    parentElement: null,
    textContent: spec.text ?? "",
    getBoundingClientRect: () => spec.rect ?? { x: 0, y: 0, width: 0, height: 0 },
  };
  for (const child of el.children) child.parentElement = el;
  if (spec.owner) el.__reactFiber$test = fiberFor(spec.owner);
  return el;
}

function run(body: FakeEl, componentName: string) {
  const source = findComponentInstances.toString();
  // eslint-disable-next-line no-new-func -- same isolation technique as buildIsolatedCollectDomSnapshot in collectdomsnapshotselfcontained.test.ts
  const factory = new Function("document", `return (${source});`);
  const isolated = factory({ body }) as (args: { componentName: string }) => {
    componentName: string;
    matches: Array<{ selector: string; preview: string; tag: string; rect: { x: number; y: number; width: number; height: number } }>;
  };
  return isolated({ componentName });
}

describe("findComponentInstances — self-contained across the page.evaluate serialization boundary", () => {
  it("runs without a ReferenceError when evaluated with access to nothing but document", () => {
    const body = makeEl({ tag: "body", children: [] });
    expect(() => run(body, "Avatar")).not.toThrow();
  });

  it("returns no matches when nothing on the page is owned by the named component", () => {
    const body = makeEl({ tag: "body", children: [makeEl({ tag: "div", owner: ["SessionCard"] })] });
    expect(run(body, "Avatar").matches).toEqual([]);
  });

  it("finds a single, unambiguous instance and returns a usable selector for it", () => {
    const body = makeEl({
      tag: "body",
      children: [makeEl({ tag: "img", id: "", owner: ["Avatar", "SessionCard"], rect: { x: 10, y: 20, width: 48, height: 48 } })],
    });
    const result = run(body, "Avatar");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].tag).toBe("img");
  });

  it(
    "finds every instance when a selector-worthy name is ambiguous — " +
      "the real problem this tool exists to solve: several SessionCards each with their own Avatar",
    () => {
      const body = makeEl({
        tag: "body",
        children: [
          makeEl({ tag: "div", owner: ["SessionCard"], children: [makeEl({ tag: "img", owner: ["Avatar", "SessionCard"], text: "card 1" })] }),
          makeEl({ tag: "div", owner: ["SessionCard"], children: [makeEl({ tag: "img", owner: ["Avatar", "SessionCard"], text: "card 2" })] }),
        ],
      });
      const result = run(body, "Avatar");
      expect(result.matches).toHaveLength(2);
    }
  );

  it(
    "matches only the element that IS the component's own root, not every element merely owned somewhere within it — " +
      "e.g. a <span> nested inside Avatar's own <div> is not itself a separate Avatar match",
    () => {
      const body = makeEl({
        tag: "body",
        children: [
          makeEl({
            tag: "div",
            owner: ["Avatar", "SessionCard"],
            children: [makeEl({ tag: "span", owner: ["Avatar", "SessionCard"], text: "status" })],
          }),
        ],
      });
      const result = run(body, "Avatar");
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].tag).toBe("div");
    }
  );

  it(
    "known limitation, consistent with the rest of the pipeline: a self-recursive component (rendering another " +
      "instance of itself) is NOT distinguished from its own outer instance — nearestOwner compares component " +
      "NAMES, and both crossings share the same name, so this reports one match at the outer boundary rather than " +
      "two. interpretDomSnapshot.ts's isComponentRoot has the identical limitation (nearestOwner(componentPath) !== " +
      "nearestOwner(parentComponentPath) is also a name comparison) — documented here rather than silently differing " +
      "from how the rest of the pipeline already treats recursive components.",
    () => {
      const body = makeEl({
        tag: "body",
        children: [
          makeEl({
            tag: "div",
            owner: ["TreeNode"],
            children: [makeEl({ tag: "div", owner: ["TreeNode", "TreeNode"] })],
          }),
        ],
      });
      const result = run(body, "TreeNode");
      expect(result.matches).toHaveLength(1);
    }
  );

  it("prefers #id for the selector when the element itself has one", () => {
    const body = makeEl({ tag: "body", children: [makeEl({ tag: "div", id: "avatar-1", owner: ["Avatar"] })] });
    expect(run(body, "Avatar").matches[0].selector).toBe("#avatar-1");
  });

  it("falls back to an nth-of-type chain rooted at the nearest ancestor id (or body) when there is no id on the element itself", () => {
    const body = makeEl({
      tag: "body",
      id: "app",
      children: [
        makeEl({ tag: "div" }), // unrelated sibling, pushes the match to position 2
        makeEl({ tag: "div", owner: ["Avatar"] }),
      ],
    });
    expect(run(body, "Avatar").matches[0].selector).toBe("div:nth-of-type(2)");
  });

  it("truncates the text preview to ~60 characters", () => {
    const longText = "x".repeat(200);
    const body = makeEl({ tag: "body", children: [makeEl({ tag: "div", owner: ["Avatar"], text: longText })] });
    expect(run(body, "Avatar").matches[0].preview.length).toBeLessThanOrEqual(60);
  });
});
