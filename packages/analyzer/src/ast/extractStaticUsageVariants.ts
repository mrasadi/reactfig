import { Node, type SourceFile, type JsxAttribute, type JsxOpeningLikeElement } from "ts-morph";
import { buildVariantCandidates, findVariantAxisFields, type VariantCaptureCandidate } from "./discoverVariantCaptures.js";

/**
 * Discovers variant-capture candidates the way `discoverVariantCaptures`
 * does, but for a component with NO `.map()` array behind it at all —
 * just the same component tag written out at multiple JSX call sites in
 * one file with different literal prop values, e.g.:
 *
 *   <Button variant="primary">Save</Button>
 *   <Button variant="secondary">Cancel</Button>
 *
 * `extractMappedDataRefs`/`discoverVariantCaptures` only ever look at
 * data already parsed from a `.map()`'s array literal — a real, common
 * pattern (StatCard/SessionCard in the sample app), but not the only one
 * a real design system uses. A component whose variants only ever show
 * up as separately-typed-out call sites (no backing array, because
 * there's no list to render — it's one Save button and one Cancel
 * button, not N interchangeable buttons) was previously invisible to
 * variant discovery entirely, regardless of how many distinct variants
 * were actually rendered on the page.
 *
 * Deliberately narrow, same spirit as `discoverVariantCaptures`'s own doc
 * comment: no invented values, nothing beyond what's textually present at
 * a real JSX call site in this file, and the same enum-token/multi-value
 * axis criteria (`findVariantAxisFields`). JSX usages already inside a
 * `.map()` callback are skipped here — those are `extractMappedDataRefs`'s
 * job, and counting a single textual call site executed N times at
 * runtime as "N static usages" would double-count it.
 */
export type StaticUsageVariantCandidate = VariantCaptureCandidate;

export interface StaticComponentUsage {
  /** e.g. "Button" */
  componentTag: string;
  parentFile: string;
  /** How many separate (non-`.map()`) JSX call sites of this tag were found in this file. */
  usageCount: number;
  variantAxisFields: string[];
  variantCandidates: StaticUsageVariantCandidate[];
}

export function extractStaticUsageVariants(sourceFile: SourceFile): StaticComponentUsage[] {
  const usagesByTag = new Map<string, JsxOpeningLikeElement[]>();

  sourceFile.forEachDescendant((node) => {
    const opening = Node.isJsxSelfClosingElement(node) ? node : Node.isJsxOpeningElement(node) ? node : null;
    if (!opening) return;
    if (isInsideMapCallback(opening)) return; // extractMappedDataRefs's job, not this one

    const tag = opening.getTagNameNode().getText();
    if (!/^[A-Z]/.test(tag)) return; // host element (e.g. "div"), not a component

    const list = usagesByTag.get(tag) ?? [];
    list.push(opening);
    usagesByTag.set(tag, list);
  });

  const results: StaticComponentUsage[] = [];
  for (const [componentTag, openings] of usagesByTag) {
    if (openings.length < 2) continue; // nothing can vary with a single call site

    const items = openings.map((opening) => literalStringAttributes(opening));
    // Only an attribute literally present (as a plain string, not an
    // expression) on every one of this tag's call sites is a candidate
    // axis — a prop only some usages set can't safely be treated as a
    // variant dimension shared across all of them.
    const commonFields = Object.keys(items[0]).filter((key) => items.every((item) => key in item));
    if (commonFields.length === 0) continue;

    const axisFields = findVariantAxisFields(items, commonFields);
    if (axisFields.length === 0) continue;

    results.push({
      componentTag,
      parentFile: sourceFile.getFilePath(),
      usageCount: openings.length,
      variantAxisFields: axisFields,
      variantCandidates: buildVariantCandidates(items, axisFields),
    });
  }

  return results;
}

function isInsideMapCallback(node: Node): boolean {
  const fn = node.getFirstAncestor((a) => Node.isArrowFunction(a) || Node.isFunctionExpression(a));
  if (!fn) return false;
  const call = fn.getParent();
  if (!call || !Node.isCallExpression(call)) return false;
  const callee = call.getExpression();
  return Node.isPropertyAccessExpression(callee) && callee.getName() === "map" && call.getArguments()[0] === fn;
}

function literalStringAttributes(opening: JsxOpeningLikeElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attr of opening.getAttributes()) {
    if (!Node.isJsxAttribute(attr)) continue;
    const value = literalStringValue(attr);
    if (value !== null) out[attr.getNameNode().getText()] = value;
  }
  return out;
}

/** `foo="bar"` or `foo={"bar"}` — a genuine literal, not an expression/variable. */
function literalStringValue(attr: JsxAttribute): string | null {
  const init = attr.getInitializer();
  if (!init) return null;
  if (Node.isStringLiteral(init)) return init.getLiteralValue();
  if (Node.isJsxExpression(init)) {
    const expr = init.getExpression();
    if (expr && Node.isStringLiteral(expr)) return expr.getLiteralValue();
  }
  return null;
}
