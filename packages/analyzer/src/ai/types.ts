/**
 * ComponentInterpretation is what the model actually produces — never raw
 * Design IR. Deterministic construction (buildDesignIR.ts) then assembles
 * the real IR by combining this with ComponentEvidence, pulling geometry/
 * color/spacing/etc. directly from evidence rather than from anything the
 * model said. This is the concrete mechanism behind "AI must not silently
 * overwrite deterministic facts" (see docs/adr/0008-ai-orchestration.md).
 *
 * Deliberately narrow: componentPath/isComponentRoot (from Phase 3.5)
 * already let deterministic code auto-detect nested-component boundaries
 * and CSS Grid fallback without AI input. What's left for the model is
 * genuinely judgment-based: which evidence-backed prop combinations are
 * real design variants, which wrapper elements are decorative noise worth
 * collapsing, and human-readable naming — see docs/analyzer/
 * ai-orchestration.md for the full boundary write-up.
 */

export interface VariantAxisInterpretation {
  /** Must be one of evidence.source.props[].name for a prop with literalValues — schema-constrained, see schema.ts. */
  propName: string;
  /** Must be a subset of that prop's literalValues — schema-constrained per request, so the model cannot invent a value. */
  confirmedValues: string[];
  /** One sentence on why this axis is a genuine design variant (or isn't included at all if it's incidental, e.g. an internal-only flag). */
  rationale: string;
}

export type NodeSemanticType = "frame" | "group" | "text" | "image" | "shape" | "skip";

export interface NodeAnnotation {
  /** Index path into the capture's dom tree, e.g. [1, 0] = children[1].children[0]. Empty array = the capture root. */
  path: number[];
  /**
   * Overrides the deterministic tag-based default mapping for this node
   * only when the model has a genuine reason to (decorative collapse,
   * text-vs-shape ambiguity a tag can't resolve). Omit to accept the
   * deterministic default.
   */
  semanticType?: NodeSemanticType;
  /** Human-readable label for this node's IR `name` field, e.g. "Label", "Icon", "Avatar Image". Raw DOM has no such name — this is cosmetic, not fidelity-affecting. */
  semanticName?: string;
  /** One short phrase explaining semanticType/skip decisions, for provenance — omitted for pure naming. */
  rationale?: string;
}

export interface ComponentInterpretation {
  /** Usually just evidence.componentName; only differs if the model has a concrete reason (e.g. evidence.componentName is a generic wrapper name). */
  componentDisplayName: string;
  variantAxes: VariantAxisInterpretation[];
  nodeAnnotations: NodeAnnotation[];
  /** Optional free-text reasoning summary, for debugging — never parsed, never affects IR construction. */
  notes?: string;
}
