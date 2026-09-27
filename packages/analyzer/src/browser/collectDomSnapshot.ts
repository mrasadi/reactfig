import type { RawDomSnapshot } from "./rawTypes.js";

/**
 * The fixed allow-list of computed-style properties the analyzer captures.
 * Deliberately not "every property getComputedStyle exposes" — this list
 * is what `evidence/interpretDomSnapshot.ts` knows how to interpret.
 * Extend both together.
 */
export const COMPUTED_STYLE_PROPERTIES = [
  "display",
  "position",
  "z-index",
  "flex-direction",
  "justify-content",
  "align-items",
  "flex-wrap",
  "gap",
  "row-gap",
  "column-gap",
  "grid-template-columns",
  "grid-template-rows",
  "grid-auto-flow",
  "grid-column",
  "grid-row",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "background-color",
  "background-image",
  "border-top-width",
  "border-top-style",
  "border-top-color",
  "border-right-width",
  "border-right-style",
  "border-right-color",
  "border-bottom-width",
  "border-bottom-style",
  "border-bottom-color",
  "border-left-width",
  "border-left-style",
  "border-left-color",
  "border-radius",
  "box-shadow",
  "filter",
  "backdrop-filter",
  "opacity",
  "overflow",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-align",
  "white-space",
  "text-overflow",
  "color",
] as const;

export interface CollectDomSnapshotArgs {
  selector: string;
  /**
   * When provided, the component-ownership walk (see `getComponentPath`
   * below) stops once it reaches a fiber owned by a component with this
   * display name, so `componentPath` stays bounded to "this captured
   * component and what it directly composes" instead of walking all the
   * way up through the app's providers/router/etc. When omitted, the walk
   * is still capped at MAX_OWNER_DEPTH as a safety bound.
   */
  rootComponentName?: string;
}

/**
 * Runs INSIDE the page via `page.evaluate(collectDomSnapshot, args)`.
 * Must be self-contained: only browser globals (`document`, `window`,
 * `getComputedStyle`), no imports from this package, since Playwright
 * serializes it via `Function.prototype.toString` and executes it in the
 * page's own JS context — anything it references has to exist there, not
 * in this Node process.
 *
 * This function is exported for type-checking and documentation purposes.
 * It cannot be exercised by a unit test in this repository's sandboxed dev
 * environment (no network access to download a Playwright browser binary
 * here) — see packages/analyzer/README.md for how it's expected to be
 * verified against a real app. Its NON_VISUAL_TAGS filter (added after a
 * real capture of a non-React page surfaced inlined `<style>` tags'
 * raw CSS text being captured as visible "text" content — see
 * docs/adr/0028) was verified in isolation against plain fake-element
 * objects instead (the actual filtering logic has no DOM dependency of
 * its own), not against a real browser DOM either.
 */
export function collectDomSnapshot(args: CollectDomSnapshotArgs): RawDomSnapshot | null {
  const STYLE_PROPERTIES = [
    "display",
    "position",
    "z-index",
    "flex-direction",
    "justify-content",
    "align-items",
    "flex-wrap",
    "gap",
    "row-gap",
    "column-gap",
    "grid-template-columns",
    "grid-template-rows",
    "grid-auto-flow",
    "grid-column",
    "grid-row",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "background-color",
    "background-image",
    "border-top-width",
    "border-top-style",
    "border-top-color",
    "border-right-width",
    "border-right-style",
    "border-right-color",
    "border-bottom-width",
    "border-bottom-style",
    "border-bottom-color",
    "border-left-width",
    "border-left-style",
    "border-left-color",
    "border-radius",
    "box-shadow",
    "filter",
    "backdrop-filter",
    "opacity",
    "overflow",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "line-height",
    "letter-spacing",
    "text-align",
    "white-space",
    "text-overflow",
    "color",
  ] as const;

  const root = document.querySelector(args.selector);
  if (!root) return null;

  /**
   * Tags that exist in the DOM but render no visual content of their own
   * — walking into them is always wrong for a *visual* capture. Real bug
   * found via a real (non-React) page: Google's homepage inlines scoped
   * `<style>` tags directly inside the captured subtree; without this
   * filter, `walk()` recursed into them and `directTextContent` grabbed
   * their raw CSS source as if it were visible text — landing as a "text"
   * node with a zero-size (unrendered elements have no box) bounding
   * rect, which then renders at nonsensical coordinates downstream. None
   * of these tags should ever become a Design IR node.
   */
  const NON_VISUAL_TAGS = new Set([
    "style",
    "script",
    "template",
    "noscript",
    "link",
    "meta",
    "title",
    "head",
    "base",
    // SVG-internal definition containers — never visible on their own,
    // only referenced (via <use>/fill="url(#...)"/etc.) by something
    // else. Walking into these produces empty placeholder boxes for
    // content that was never meant to render at its own position.
    "defs",
    "symbol",
    "clippath",
    "mask",
    "marker",
    "pattern",
    "metadata",
    "desc",
  ]);

  function visualChildren(el: Element): Element[] {
    return Array.from(el.children).filter((child) => !NON_VISUAL_TAGS.has(child.tagName.toLowerCase()));
  }

  function directTextContent(el: Element): string | null {
    let text = "";
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent ?? "";
      }
    }
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  /**
   * When an inline `<svg>` icon has no explicit `viewBox`, one is
   * synthesized (from its own `width`/`height` attributes, or its
   * rendered bounding rect as a last resort) so it still scales
   * correctly once re-embedded at a DIFFERENT size elsewhere (a Design
   * IR image node's own captured bounds, not necessarily this element's
   * own) — an `<svg>` with literal width/height but no viewBox does not
   * scale via CSS/attribute resizing the way one with a viewBox does.
   * Returns null when a viewBox is already present (nothing to inject).
   */
  function svgViewBoxFallback(el: Element): string | null {
    if (el.getAttribute("viewBox")) return null;
    const w = el.getAttribute("width");
    const h = el.getAttribute("height");
    if (w && h && !Number.isNaN(Number(w)) && !Number.isNaN(Number(h))) {
      return `0 0 ${w} ${h}`;
    }
    const rect = el.getBoundingClientRect();
    return `0 0 ${rect.width} ${rect.height}`;
  }

  /**
   * Captures an inline `<svg>` icon's own markup whole, for re-embedding
   * as a Design IR image node's asset (see mapNode's `el.image` branch in
   * buildDesignIR.ts, and docs/adr/0030) — Design IR's node model has no
   * vector/path node type, so an icon is treated as one flattened visual
   * unit, the same as an `<img>`, rather than decomposed into its
   * constituent `<path>`/`<circle>`/etc children.
   */
  function captureSvgMarkup(el: Element): string {
    let markup = el.outerHTML;
    // fill="currentColor"/stroke="currentColor" only resolves correctly
    // inside the page this was captured from (it inherits the CSS `color`
    // of wherever it's embedded) — re-embedded as a standalone data: URI
    // asset elsewhere, "wherever it's embedded" is no longer this
    // element's own ancestry, so it would silently resolve to whatever
    // (likely black) default applies there instead. Resolved here, once,
    // to this element's own actual rendered color, while that context is
    // still available.
    if (markup.includes("currentColor")) {
      const resolvedColor = getComputedStyle(el).getPropertyValue("color");
      markup = markup.split("currentColor").join(resolvedColor);
    }
    const viewBox = svgViewBoxFallback(el);
    if (viewBox) {
      markup = markup.replace("<svg", `<svg viewBox="${viewBox}"`);
    }
    return markup;
  }

  const MAX_OWNER_DEPTH = 12;

  /**
    * Finds the property name React attaches to a DOM node for its fiber
    * (`__reactFiber$<key>` in React 16.9+, `__reactInternalInstance$<key>` in
    * older versions) so we can read the fiber without any external library.
    */
  function findFiberKey(el: Record<string, unknown>): string | undefined {
    return Object.keys(el).find(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
      );
  }

  function componentDisplayName(type: unknown): string | null {
    if (!type || typeof type === "string") return null; // host element type (e.g. "div"), not a component
    const t = type as { displayName?: string; name?: string; type?: unknown; render?: { displayName?: string; name?: string } };
    if (t.displayName) return t.displayName;
    if (t.name) return t.name;
    // React.memo(Component) — the memo wrapper object itself
    // ({ $$typeof, type, compare }) is almost never given its own name;
    // the actual component function lives at `.type`. Recurse so a
    // memo(forwardRef(...)) double-wrap still resolves too.
    if (t.type) {
      const inner = componentDisplayName(t.type);
      if (inner) return inner;
    }
    // React.forwardRef((props, ref) => ...) — the actual render function
    // lives at `.render`; the forwardRef wrapper itself
    // ({ $$typeof, render }) is almost never given its own name either.
    if (t.render) return t.render.displayName ?? t.render.name ?? null;
    return null;
  }

  /**
    * Best-effort component-ownership chain for `el`, outermost first, via
    * React's `_debugOwner` fiber chain — the same internal field React
    * DevTools itself reads to build its Components tree. This answers "which
    * component's JSX created this element" (composition/authorship), not
    * "which component's rendered DOM subtree physically contains this
    * element" (which a plain `fiber.return` walk would give and would
    * attribute pass-through `children` content to the wrong owner).
    *
    * `_debugOwner` is a React-internal, dev-build-only field: this returns
    * null gracefully in production builds, for non-React DOM, or if React's
    * internals change shape in a future major version — it is deliberately
    * not treated as a reliable data source outside of local development
    * inspection, which is this project's target scenario (ReactFig
    * inspects a locally running dev server).
    */
  function getComponentPath(el: Element, rootComponentName?: string): string[] | null {
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
        if (rootComponentName && name === rootComponentName) break;
        }
      owner = owner._debugOwner as typeof owner;
      depth++;
      }
    return names.length > 0 ? names : null;
  }

  function walk(el: Element): RawDomSnapshot {
    const cs = getComputedStyle(el);
    const computedStyle: Record<string, string> = {};
    for (const prop of STYLE_PROPERTIES) {
      computedStyle[prop] = cs.getPropertyValue(prop);
    }
    const rect = el.getBoundingClientRect();
    const isImg = el.tagName.toLowerCase() === "img";
    const isSvg = el.tagName.toLowerCase() === "svg";

    return {
      tag: el.tagName.toLowerCase(),
      attributes: {
        id: el.id || undefined,
        className: typeof el.className === "string" && el.className ? el.className : undefined,
        role: el.getAttribute("role") ?? undefined,
        // The resolved property, not getAttribute("src") — getAttribute
        // returns the literal markup value verbatim (e.g. the root-relative
        // path a bundler's dev server commonly serves imported images at,
        // like "/static/media/avatar.abc123.png"), which is not a fetchable
        // URL on its own. The IDL property is always browser-resolved to a
        // fully qualified absolute URL, which is what registerAsset() (via
        // buildDesignIR.ts) needs this to be, since it flows unmodified
        // into AssetRef.path and, from there, into export_design_artifact's
        // fetch step (packages/mcp/src/tools/exportDesignArtifact.ts),
        // which only fetches http(s) paths and otherwise leaves the asset
        // unembedded.
        src: isImg ? (el as HTMLImageElement).src || undefined : undefined,
        alt: el.getAttribute("alt") ?? undefined,
      },
      textContent: directTextContent(el),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      computedStyle,
      naturalWidth: isImg ? (el as HTMLImageElement).naturalWidth : null,
      naturalHeight: isImg ? (el as HTMLImageElement).naturalHeight : null,
      svgMarkup: isSvg ? captureSvgMarkup(el) : null,
      componentPath: getComponentPath(el, args.rootComponentName),
      // An <svg> icon is captured whole (svgMarkup above), not walked —
      // its internal <path>/<circle>/<defs>/etc are markup for a single
      // flattened visual unit, not independent Design IR nodes of their
      // own (see captureSvgMarkup's own doc comment).
      children: isSvg ? [] : visualChildren(el).map(walk),
    };
  }

  return walk(root);
}