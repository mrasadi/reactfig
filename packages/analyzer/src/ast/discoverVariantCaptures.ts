import type { MappedComponentUsage } from "./extractMappedDataRefs.js";

/**
 * Minimal, deterministic variant-capture discovery: given a component
 * that's already known to be rendered multiple times from a `.map()` over
 * a literal array (`extractMappedDataRefs`'s `MappedComponentUsage`),
 * finds which of its props take more than one distinct, enum-like value
 * across those instances — e.g. `StatCard.tone` ("neutral"/"success"/
 * "warning") or `SessionCard.status` ("completed"/"scheduled"/"missed") —
 * and proposes one capture per distinct value actually observed.
 *
 * This is deliberately not a general prop-discovery or CSS-analysis
 * engine (see Issue.md's "Implement Minimal Multi-Variant Capture", §3,
 * §11): it only ever looks at data the pipeline has already extracted
 * statically from source — the same `.map()` array `extractMappedDataRefs`
 * already parsed — and only ever proposes states that are *already
 * rendered somewhere on the page* (one of the mapped instances), never an
 * invented or interpolated one. A variant value this can't tie back to an
 * actual rendered instance simply isn't proposed; the caller (Run.md, via
 * generate_design_ir's existing `variants` argument) decides what to do
 * about anything left uncaptured.
 */

export interface VariantCaptureCandidate {
  /** 0-based position of this state's first (and canonical) occurrence among the `.map()` items — the caller uses this to target that specific rendered DOM instance (e.g. an `:nth-of-type` selector), since a plain class selector would ambiguously match every instance alike. */
  instanceIndex: number;
  /** Only the axis fields — e.g. `{ tone: "warning" }`, not the item's other fields (label/value/etc). Matches generate_design_ir's `VariantCaptureSpec.propValues` shape directly. */
  propValues: Record<string, string>;
}

export interface DiscoverVariantCapturesResult {
  /** Prop names treated as variant axes: passed as an actual JSX prop (via `mappedKeys`, so restricted to fields the component really receives — no fields invented from the data array's shape alone), string-valued, enum-token-shaped, with more than one distinct value across the mapped instances. Empty when nothing qualifies — most components have no meaningful variant axis at all, and this leaves those untouched. */
  axisFields: string[];
  /** One entry per distinct combination of axis values actually observed, deduped (the same visual state is never proposed twice) and in first-occurrence order. Empty when axisFields is empty. */
  candidates: VariantCaptureCandidate[];
}

const ENUM_TOKEN_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,23}$/; // short, identifier-like — "neutral", "success", not "Amir Hosseini" or a URL

/**
 * Shared by `discoverVariantCaptures` (`.map()`-driven usage) and
 * `extractStaticUsageVariants.ts` (repeated call-site usage, no array at
 * all) — same dedup/instanceIndex convention either way: first-occurrence
 * order, one candidate per distinct combination of axis values actually
 * observed.
 */
export function buildVariantCandidates(items: Array<Record<string, unknown>>, axisFields: string[]): VariantCaptureCandidate[] {
  const candidates: VariantCaptureCandidate[] = [];
  const seen = new Set<string>();
  items.forEach((item, instanceIndex) => {
    const propValues: Record<string, string> = {};
    for (const field of axisFields) propValues[field] = item[field] as string;
    const key = JSON.stringify(propValues);
    if (seen.has(key)) return; // same combination already covered by an earlier instance
    seen.add(key);
    candidates.push({ instanceIndex, propValues });
  });
  return candidates;
}

/**
 * Which of `items`' fields (restricted to `candidateFields`) qualify as a
 * variant axis: string-valued on every item, enum-token-shaped, and take
 * more than one distinct value across `items`. Shared by
 * `discoverVariantCaptures` and `extractStaticUsageVariants.ts`.
 */
export function findVariantAxisFields(items: Array<Record<string, unknown>>, candidateFields: string[]): string[] {
  return candidateFields
    .filter((field) => {
      const values = items.map((item) => item[field]);
      if (values.some((v) => typeof v !== "string")) return false;
      if (values.some((v) => !ENUM_TOKEN_RE.test(v as string))) return false;
      return new Set(values).size > 1;
    })
    .sort();
}

export function discoverVariantCaptures(usage: MappedComponentUsage): DiscoverVariantCapturesResult {
  const dataSource = usage.dataSources.find((d) => d.variableName === usage.dataVariableName);
  const items = dataSource?.items ?? [];
  if (items.length < 2) return { axisFields: [], candidates: [] }; // nothing can vary with 0 or 1 instance

  // Only fields the component actually receives as a prop (spread or explicit access) —
  // never a field present in the data array but not actually passed down.
  const mappedFieldNames = [...new Set(usage.mappedKeys.map((k) => k.keyInItem))];

  const axisFields = findVariantAxisFields(items, mappedFieldNames);
  if (axisFields.length === 0) return { axisFields: [], candidates: [] };

  return { axisFields, candidates: buildVariantCandidates(items, axisFields) };
}
