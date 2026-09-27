import type { ComponentEvidence, ElementEvidence } from "../evidence/types.js";
import type { EvidenceStore } from "./evidenceStore.js";

/**
 * A summarized DOM node, used once a subtree is collapsed (see
 * `pruneForBundle`) instead of the full ElementEvidence.
 */
interface PrunedNode {
  tag: string;
  bounds: ElementEvidence["bounds"];
  layoutMode: string;
  textContent: string | null;
  children: PrunedNode[] | { collapsed: true; componentPath: string[]; childCount: number };
}

/**
 * Depth/boundary-limited view of one capture's DOM tree: full detail for
 * the target component and its direct content, collapsed to a one-line
 * summary once a nested component boundary is entered (isComponentRoot
 * with a different nearest owner than the captured root component). This
 * is the concrete implementation of the pruning strategy documented in
 * docs/analyzer/evidence-model.md §9 — componentPath/isComponentRoot exist
 * specifically to make this possible without re-touching the inspection
 * layer.
 */
function pruneForBundle(node: ElementEvidence, rootComponentName: string, depth: number): PrunedNode {
  const isNestedBoundary = node.isComponentRoot && nearestOwner(node.componentPath) !== rootComponentName && depth > 0;

  if (isNestedBoundary) {
    return {
      tag: node.tag,
      bounds: node.bounds,
      layoutMode: node.style.layoutMode,
      textContent: node.textContent,
      children: { collapsed: true, componentPath: node.componentPath ?? [], childCount: node.children.length },
    };
  }

  return {
    tag: node.tag,
    bounds: node.bounds,
    layoutMode: node.style.layoutMode,
    textContent: node.textContent,
    children: node.children.map((c) => pruneForBundle(c, rootComponentName, depth + 1)),
  };
}

function nearestOwner(path: string[] | null): string | null {
  return path && path.length > 0 ? path[path.length - 1] : null;
}

function layoutModesDiffer(evidence: ComponentEvidence): boolean {
  const modes = new Set(evidence.captures.map((c) => c.dom.style.layoutMode));
  return modes.size > 1;
}

export interface InitialBundle {
  /** Plain-text summary for the model's first message. */
  text: string;
  /** Path to the primary capture's screenshot, if any — attached as an image part only when the provider supports vision. */
  primaryScreenshotPath: string | null;
}

/**
 * Builds the pruned initial evidence bundle per the "Evidence Selection"
 * requirement: target component + direct children (full detail) +
 * nested-component summaries (not full subtrees) + capture list (metadata
 * only — full DOM for a specific capture is available via get_evidence) +
 * asset list. Responsive screenshots are NOT attached here even when
 * layout modes differ — only flagged in text — since screenshots are the
 * expensive part; the model can request one via get_evidence if the text
 * flag isn't enough to reason from.
 */
export function buildInitialBundle(evidence: ComponentEvidence, store: EvidenceStore): InitialBundle {
  const defaultCapture = evidence.captures.find((c) => !c.propValues) ?? evidence.captures[0];
  const pruned = defaultCapture ? pruneForBundle(defaultCapture.dom, evidence.componentName, 0) : null;

  const captureList = store.listCaptures();
  const assets = store.listAssets();
  const responsiveNote = layoutModesDiffer(evidence)
    ? `Layout mode differs across captures: ${captureList.map((c) => `${c.viewportLabel ?? c.label}=${c.rootLayoutMode}`).join(", ")}. Request a specific capture via get_evidence(kind:"viewport_capture") if you need the full detail.`
    : "Layout mode is consistent across all captures.";

  const lines = [
    `Component: ${evidence.componentName}`,
    `Source props: ${JSON.stringify(evidence.source.props.map((p) => ({ name: p.name, tsType: p.tsType, literalValues: p.literalValues, required: p.required })))}`,
    `Sub-components composed (from source imports): ${evidence.source.importedComponents.map((c) => c.name).join(", ") || "none"}`,
    `Captures available: ${JSON.stringify(captureList)}`,
    responsiveNote,
    `Assets referenced: ${JSON.stringify(assets)}`,
    `Known limitations of this evidence: ${evidence.meta.limitations.join(" | ")}`,
    pruned ? `Default capture DOM (pruned — nested component subtrees are collapsed; use get_evidence(kind:"nested_component") or (kind:"element") for full detail):\n${JSON.stringify(pruned)}` : "No default capture available.",
  ];

  return {
    text: lines.join("\n\n"),
    primaryScreenshotPath: defaultCapture?.screenshot?.path ?? null,
  };
}
