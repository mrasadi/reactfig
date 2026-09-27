import { Node } from "ts-morph";

/**
 * Detects whether a component's own function body calls `createPortal`
 * anywhere — either the bare identifier (`import { createPortal } from
 * "react-dom"`) or a property access (`ReactDOM.createPortal(...)`,
 * under whatever alias the import uses). Deliberately a name-based
 * heuristic, not an import-resolution check: matching on the call
 * shape alone is exactly the same posture as this project's other
 * AST heuristics (`extractStaticUsageVariants`'s `.map()` skip,
 * `discoverVariantCaptures`'s enum-token shape) — good enough to be a
 * genuinely useful, near-zero-false-positive signal without needing to
 * fully resolve where `createPortal` actually came from.
 *
 * This exists because of a real, structural limitation elsewhere in this
 * pipeline, not because it fixes it: `collectDomSnapshot.ts` walks the
 * DOM tree from a captured root element downward (`el.children`) to
 * build evidence. A `createPortal(children, container)` call renders
 * `children` into `container` — typically `document.body` or a similar
 * top-level node — which is NOT a DOM descendant of this component's own
 * root element at all. That content is therefore silently absent from
 * this component's own captured evidence; DOM-tree walking has no way to
 * discover it, and no amount of walking further down the DOM tree that
 * IS reachable will find it. This function turns that silent gap into an
 * explicit, actionable signal instead: a caller seeing `usesPortal: true`
 * on a component's source evidence knows its capture may be incomplete,
 * and — if the portaled content needs its own evidence — that it likely
 * needs to be captured as its own separate component (found and
 * targeted directly, since it usually renders as its own recognizable
 * subtree under `container` once mounted) rather than assumed to be part
 * of this one.
 *
 * Full portal-aware capture (detecting the fiber-level `HostPortal`
 * boundary and splicing the portaled subtree into the right place in
 * this component's own evidence automatically) is NOT implemented here —
 * that needs fiber-tree walking validated against a real React runtime,
 * which this detector deliberately doesn't attempt.
 */
export function detectPortalUsage(fn: Node): boolean {
  let found = false;
  fn.forEachDescendant((node, traversal) => {
    if (found) {
      traversal.stop();
      return;
    }
    if (!Node.isCallExpression(node)) return;
    const callee = node.getExpression();
    if (Node.isIdentifier(callee) && callee.getText() === "createPortal") {
      found = true;
      traversal.stop();
      return;
    }
    if (Node.isPropertyAccessExpression(callee) && callee.getName() === "createPortal") {
      found = true;
      traversal.stop();
    }
  });
  return found;
}
