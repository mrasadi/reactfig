export interface ResolveComponentBoundaryArgs {
  /** A selector that resolves to exactly one DOM element — the starting point for boundary resolution. For `direction: "root"` this is typically a raw, not-yet-resolved selector for whatever the developer clicked (see buildSelector below); for `"parent"`/`"child"` it's a previously resolved boundary's own selector, being adjusted one step. */
  selector: string;
  /**
   * `"root"` (default): resolve the clicked element outward to the
   * nearest enclosing component-instance root — the same "isComponentRoot"
   * boundary `evidence/interpretDomSnapshot.ts` computes for evidence
   * capture (nearest owner differs from the parent's nearest owner), run
   * outward from one starting node instead of over a whole captured tree.
   * `"parent"`: move the resolved boundary one component out — to the
   * root of the next enclosing component instance.
   * `"child"`: move the resolved boundary one component in — to the
   * first nested component-instance root found inside the current one.
   */
  direction?: "root" | "parent" | "child";
}

export interface ComponentBoundaryResult {
  /** A specific, resolves-to-this-exact-element-right-now selector — see buildSelector's own caveat: not durable across a rebuild, only usable for the immediate capture that follows. */
  selector: string;
  /** Best-effort React component-ownership chain, outermost first, ending at this boundary's own owner — null when no React fiber/ownership info could be found (production build, non-React DOM, or a plain host element with no owner at all). */
  componentPath: string[] | null;
  tag: string;
  preview: string;
  rect: { x: number; y: number; width: number; height: number };
}

/**
 * Runs INSIDE the page via `page.evaluate(resolveComponentBoundary, args)`
 * — same self-contained-serialization constraint as
 * `collectDomSnapshot.ts` and `findComponentInstances.ts` (only browser
 * globals, no imports, no references outside its own body: Playwright
 * reconstructs this from `Function.prototype.toString()` and runs it in
 * the page's own JS context). The fiber-walk and selector-building
 * helpers below are deliberately duplicated from those two files rather
 * than shared, for the same reason they already duplicate each other —
 * there is no way to share code across this serialization boundary. Keep
 * all three in sync if the fiber-walk logic itself ever changes.
 *
 * This answers the inverse of `findComponentInstances.ts`'s question.
 * That function starts from a known component name and finds every
 * matching instance on the page; this one starts from one already-known
 * DOM node (whatever the developer's cursor is over or just clicked) and
 * finds the nearest component-instance boundary around it — the "is the
 * DOM node I clicked actually the component, or just some div inside it"
 * problem Interactive Capture's element picker exists to solve. Exists
 * to make that resolution a plain, testable function instead of overlay
 * script inline logic (see collection/overlayScript.ts, which embeds this
 * function's source via `.toString()` into the injected page script
 * rather than re-implementing the walk by hand a fourth time).
 */
export function resolveComponentBoundary(args: ResolveComponentBoundaryArgs): ComponentBoundaryResult | null {
  const MAX_OWNER_DEPTH = 12;

  function findFiberKey(el: Record<string, unknown>): string | undefined {
    return Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
  }

  function componentDisplayName(type: unknown): string | null {
    if (!type || typeof type === "string") return null;
    const t = type as { displayName?: string; name?: string; type?: unknown; render?: { displayName?: string; name?: string } };
    if (t.displayName) return t.displayName;
    if (t.name) return t.name;
    if (t.type) {
      const inner = componentDisplayName(t.type);
      if (inner) return inner;
    }
    if (t.render) return t.render.displayName ?? t.render.name ?? null;
    return null;
  }

  function getComponentPath(el: Element): string[] | null {
    const key = findFiberKey(el as unknown as Record<string, unknown>);
    if (!key) return null;
    const fiber = (el as unknown as Record<string, unknown>)[key] as { _debugOwner?: unknown } | undefined;
    if (!fiber) return null;

    const names: string[] = [];
    let owner = fiber._debugOwner as { type?: unknown; _debugOwner?: unknown } | null | undefined;
    let depth = 0;
    while (owner && depth < MAX_OWNER_DEPTH) {
      const name = componentDisplayName(owner.type);
      if (name) names.unshift(name);
      owner = owner._debugOwner as typeof owner;
      depth++;
    }
    return names.length > 0 ? names : null;
  }

  function nearestOwner(path: string[] | null): string | null {
    return path && path.length > 0 ? path[path.length - 1] : null;
  }

  function buildSelector(el: Element): string {
    if (el.id) return `#${el.id}`;
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.body) {
      if (node.id) {
        parts.unshift(`#${node.id}`);
        break;
      }
      const parent: Element | null = node.parentElement;
      if (!parent) {
        parts.unshift(node.tagName.toLowerCase());
        break;
      }
      const sameTagSiblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      const index = sameTagSiblings.indexOf(node) + 1;
      parts.unshift(sameTagSiblings.length > 1 ? `${node.tagName.toLowerCase()}:nth-of-type(${index})` : node.tagName.toLowerCase());
      node = parent;
    }
    return parts.join(" > ");
  }

  function directTextPreview(el: Element): string {
    const text = (el.textContent ?? "").trim().replace(/\s+/g, " ");
    return text.length > 60 ? `${text.slice(0, 57)}...` : text;
  }

  function describe(el: Element): ComponentBoundaryResult {
    const rect = el.getBoundingClientRect();
    return {
      selector: buildSelector(el),
      componentPath: getComponentPath(el),
      tag: el.tagName.toLowerCase(),
      preview: directTextPreview(el),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  }

  /** Walks upward from `el` while each ancestor still shares `el`'s own nearest owner, returning the outermost such element — the actual "root" resolution, reused by both `direction: "root"` and, after `"parent"` finds the next owner in, to resolve *that* owner's own full boundary. */
  function walkUpToOwnerRoot(el: Element): Element {
    const ownOwner = nearestOwner(getComponentPath(el));
    if (ownOwner === null) return el;
    let boundary = el;
    let node: Element | null = el.parentElement;
    while (node && node !== document.body) {
      if (nearestOwner(getComponentPath(node)) !== ownOwner) break;
      boundary = node;
      node = node.parentElement;
    }
    return boundary;
  }

  /**
   * True if `el` or ANY of its ancestors up to (not including) `body`
   * carries a React fiber — i.e. there is *some* component-owner
   * information somewhere in this chain for owner-walking to work with
   * at all. False on a page with no React whatsoever (docs/adr/0029) —
   * source-less generation's whole point (ADR 0027) is capturing exactly
   * such pages, so this case isn't rare or a misuse, it's the expected
   * one for that feature.
   */
  function hasOwnerInfoInChain(el: Element): boolean {
    let node: Element | null = el;
    while (node && node !== document.body) {
      if (getComponentPath(node) !== null) return true;
      node = node.parentElement;
    }
    return false;
  }

  const start = document.querySelector(args.selector);
  if (!start) return null;

  const direction = args.direction ?? "root";

  if (direction === "root") {
    return describe(walkUpToOwnerRoot(start));
  }

  if (direction === "parent") {
    if (!hasOwnerInfoInChain(start)) {
      // Plain-DOM fallback (docs/adr/0029): no React fiber anywhere in
      // this chain — there is no "component owner" to walk toward, so
      // stepping to the page's whole <body> on every click would make
      // fine-grained adjustment impossible (exactly what was observed
      // capturing a real, non-React page — see the ADR). Step exactly
      // one DOM level instead, the same increment a developer would
      // reach for in DevTools' own element picker on a plain page.
      const parent = start.parentElement;
      return describe(parent ?? start);
    }
    const startOwner = nearestOwner(getComponentPath(start));
    let node: Element | null = start.parentElement;
    while (node && node !== document.body) {
      const owner = nearestOwner(getComponentPath(node));
      if (owner !== null && owner !== startOwner) {
        return describe(walkUpToOwnerRoot(node));
      }
      node = node.parentElement;
    }
    // No further enclosing component instance found — degrade gracefully
    // to the page body rather than returning null, so the developer's
    // "select parent" click always does *something* visible rather than
    // silently failing at the top of the tree.
    return document.body ? describe(document.body) : describe(start);
  }

  // direction === "child": first nested component-instance root found in
  // document order, depth-first — mirrors findComponentInstances.ts's own
  // walk, just stopping at the first match instead of collecting all of
  // them.
  if (!hasOwnerInfoInChain(start)) {
    // Plain-DOM fallback (docs/adr/0029), symmetric with "parent" above:
    // no owner info to descend toward, so step exactly one DOM level
    // down (first element child) instead of the owner-walk finding
    // nothing and treating `start` as already the innermost boundary.
    const firstChild = start.children[0] as Element | undefined;
    return describe(firstChild ?? start);
  }
  const startOwner = nearestOwner(getComponentPath(start));
  function findNestedRoot(el: Element): Element | null {
    for (const child of Array.from(el.children)) {
      const owner = nearestOwner(getComponentPath(child));
      if (owner !== null && owner !== startOwner) return child;
      const nested = findNestedRoot(child);
      if (nested) return nested;
    }
    return null;
  }
  const nested = findNestedRoot(start);
  // No nested component found (a leaf component) — adjustment is a no-op,
  // not a failure; the developer's current selection is already the
  // innermost boundary available.
  return describe(nested ?? start);
}
