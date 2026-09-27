export interface FindComponentInstancesArgs {
  /** The React component displayName/function name to find instances of — same value you'd pass as generate_design_ir's componentName/rootComponentName. */
  componentName: string;
}

export interface ComponentInstanceMatch {
  /** A specific CSS selector for this one element — prefers `#id`, falls back to an `:nth-of-type` chain (see buildSelector). Always resolves to exactly this element on the page it was found on. */
  selector: string;
  /** First ~60 characters of this element's own direct text content, for telling multiple matches apart (e.g. which SessionCard's Avatar this is) without needing a screenshot. */
  preview: string;
  rect: { x: number; y: number; width: number; height: number };
  tag: string;
}

export interface FindComponentInstancesResult {
  componentName: string;
  matches: ComponentInstanceMatch[];
}

/**
 * Runs INSIDE the page via `page.evaluate(findComponentInstances, args)` —
 * see collectDomSnapshot.ts's own doc comment for why this must stay
 * completely self-contained (only browser globals, no imports, no
 * references to anything outside its own function body: Playwright
 * serializes it via `Function.prototype.toString` and the reconstructed
 * source runs in the page's own JS context, which has no access to this
 * module's scope). The fiber-walk helpers below (findFiberKey,
 * componentDisplayName, getComponentPath) are deliberately duplicated
 * from collectDomSnapshot.ts rather than shared — there is no way to
 * share code across this serialization boundary — so keep both in sync
 * if the fiber-walk logic itself ever changes.
 *
 * Exists to answer the question a caller has to guess at today when
 * writing a `generate_design_ir` call: "what selector actually resolves
 * to this component's own root element?" Scans the whole page once and
 * returns a specific, ready-to-use selector for every element that is
 * genuinely the root of an instance of `componentName` — not merely
 * "owned somewhere by" it, the same "isComponentRoot" concept
 * interpretDomSnapshot.ts computes for evidence capture (nearest owner
 * differs from the parent's nearest owner) — so a caller doesn't have to
 * guess a CSS class or tag selector and risk it silently resolving to
 * the wrong element (see captureComponent.ts's verifyCapturedOwner,
 * added specifically to catch that after the fact; this tool exists to
 * avoid needing that catch in the first place).
 */
export function findComponentInstances(args: FindComponentInstancesArgs): FindComponentInstancesResult {
  const MAX_OWNER_DEPTH = 12;

  function findFiberKey(el: Record<string, unknown>): string | undefined {
    return Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
  }

  function componentDisplayName(type: unknown): string | null {
    if (!type || typeof type === "string") return null;
    const t = type as { displayName?: string; name?: string; type?: unknown; render?: { displayName?: string; name?: string } };
    if (t.displayName) return t.displayName;
    if (t.name) return t.name;
    // React.memo(...) / React.forwardRef(...) — see collectDomSnapshot.ts's
    // componentDisplayName, which this must stay in sync with.
    if (t.type) {
      const inner = componentDisplayName(t.type);
      if (inner) return inner;
    }
    if (t.render) return t.render.displayName ?? t.render.name ?? null;
    return null;
  }

  // Same walk as collectDomSnapshot.ts's getComponentPath, truncated at
  // args.componentName for the same reason: bounds the walk to "this
  // component and what it directly composes" rather than climbing all
  // the way up through app-level providers/router/etc. on every element
  // of a potentially large page. (Removing the truncation would not, on
  // its own, make a self-recursive component's nested instance
  // distinguishable from its own outer instance either — see the "known
  // limitation" test below — so there's no correctness reason to diverge
  // from collectDomSnapshot.ts's behavior here.)
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
      if (name) {
        names.unshift(name);
        if (name === args.componentName) break;
      }
      owner = owner._debugOwner as typeof owner;
      depth++;
    }
    return names.length > 0 ? names : null;
  }

  function nearestOwner(path: string[] | null): string | null {
    return path && path.length > 0 ? path[path.length - 1] : null;
  }

  /**
   * A specific selector for exactly this element. Prefers `#id` (on the
   * element itself, or the nearest ancestor with one, which shortens the
   * chain while staying unique); otherwise builds a `tag:nth-of-type(n)`
   * chain from the nearest such ancestor (or document.body) down to this
   * element. Not intended as a durable, refactor-proof selector to embed
   * in a test suite — only as something that resolves to this exact
   * element right now, for a one-time generate_design_ir call.
   */
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

  const matches: ComponentInstanceMatch[] = [];

  function walk(el: Element, parentOwner: string | null): void {
    const owner = nearestOwner(getComponentPath(el));
    if (owner === args.componentName && owner !== parentOwner) {
      const rect = el.getBoundingClientRect();
      matches.push({
        selector: buildSelector(el),
        preview: directTextPreview(el),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        tag: el.tagName.toLowerCase(),
      });
    }
    // Recurse regardless of whether this element matched — a component
    // instance's own subtree can contain further, genuinely distinct
    // instances of other components. (A component recursively rendering
    // ITSELF is a known exception: nearestOwner compares names, and a
    // recursive instance shares its outer instance's name, so it isn't
    // distinguished as a new match — the same limitation
    // interpretDomSnapshot.ts's isComponentRoot already has.)
    for (const child of Array.from(el.children)) {
      walk(child, owner);
    }
  }

  if (document.body) walk(document.body, null);

  return { componentName: args.componentName, matches };
}
