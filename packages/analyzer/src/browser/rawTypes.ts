/**
 * The shape produced inside the browser by `collectDomSnapshot` (see
 * `browser/collectDomSnapshot.ts`), before any interpretation. Every field
 * is a plain string/number/null so it survives Playwright's
 * `page.evaluate` serialization boundary untouched.
 *
 * `computedStyle` carries raw values for a fixed allow-list of CSS
 * properties (see COMPUTED_STYLE_PROPERTIES in collectDomSnapshot.ts) —
 * deliberately not "every computed style property", to keep snapshots
 * small and the allow-list auditable.
 */
export interface RawDomSnapshot {
  tag: string;
  /** `src` is the resolved absolute URL (`HTMLImageElement.src`, the IDL property), not the raw markup attribute — see collectDomSnapshot.ts's walk(). */
  attributes: { id?: string; className?: string; role?: string; src?: string; alt?: string };
  textContent: string | null;
  rect: { x: number; y: number; width: number; height: number };
  computedStyle: Record<string, string>;
  naturalWidth: number | null;
  naturalHeight: number | null;
  /**
   * Present only when `tag === "svg"` — the element's own serialized
   * markup (`outerHTML`), with any `currentColor` fill/stroke already
   * resolved to this element's own computed `color` (see
   * collectDomSnapshot.ts's walk() for why: `currentColor` only resolves
   * correctly inside the page it was captured from, not wherever this
   * markup ends up re-embedded). Captured whole, not walked into — an
   * inline SVG icon (Design IR's node model has no vector/path node type)
   * is captured as one flattened visual unit, the same way an `<img>` is,
   * not decomposed into its constituent `<path>`/`<circle>`/etc children.
   * See docs/adr/0030.
   */
  svgMarkup: string | null;
  /**
   * Best-effort component ownership chain for this element (outermost
   * first), derived from React's fiber `_debugOwner` chain — see
   * `collectDomSnapshot.ts`. Null when unavailable.
   */
  componentPath: string[] | null;
  children: RawDomSnapshot[];
}
