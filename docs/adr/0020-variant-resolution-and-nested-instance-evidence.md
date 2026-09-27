# ADR 0020: Per-instance variant resolution and nested-instance evidence capture

## Status

Accepted. Fixes Issue.md §9's two reported visual bugs (SessionCard Badge
status, StatCard tone border) at the actual layer where each was lost, plus
one further bug found while verifying the fix end-to-end against the real
merged Dashboard artifact rather than trusting the unit-level fix alone.

## Context

Both bugs were traced against real captured evidence already present in
this repo's `.reactfig/checkpoints/{StatCard,SessionCard}/v001/evidence.json`
(a genuine prior live-browser run) rather than a synthetic reproduction.
Issue.md §10 asked us not to assume browser capture was broken before
checking; it wasn't — `evidence.json` already contains three distinct,
correct `border-left` colors for StatCard and three distinct, correct
Badge `background-color`/text pairs nested inside SessionCard's own three
status captures. The loss happened downstream, in two places, plus a
third found only by actually re-running `merge_design_ir_checkpoints`
against the real checkpoints and inspecting the resulting artifact instead
of stopping at the first two unit-level fixes.

## Decision 1: `mapBorder` picks the widest side as the paint source, not the first resolvable one

`packages/analyzer/src/ai/buildDesignIR.ts`'s `mapBorder` maps four
independently-captured border sides onto Figma's single shared
stroke color. It previously picked `present.find(s => mapColor(s.color))`
— the first side, in top/right/bottom/left order, that had a resolvable
color. For StatCard that side is always the shared 1px neutral-gray
top/right/bottom border; the 4px tone-colored left accent (the actual
visual carrying the variant's identity) was only ever picked if the
"first" side happened to be transparent.

Fixed to prefer whichever side is *widest* (ties fall back to the old
first-resolvable-color rule, so a uniform border is unaffected). A
side drawn noticeably thicker than its neighbors is, by construction, the
one a design means to draw attention to — this is the same heuristic
across any component with an accent-border pattern, not something scoped
to StatCard specifically.

## Decision 2: a nested-component-boundary instance carries its own observed evidence as an `InstanceOverride`

When `buildDesignIR`'s `mapNode` crosses into a nested dependency
component (e.g. Badge inside SessionCard, Avatar inside Header), it
replaces that whole subtree with a bare `{ kind: "component", componentId:
"external:<Name>" }` instance reference — deliberate, per the existing
module doc comment, since resolving that dependency's own definition is a
separate concern. What wasn't deliberate: doing so discarded the
element's own directly-observed styling (its background/border, and — for
a "pill"-shaped leaf like Badge's `<span class="badge">` — its own text)
even though it was captured, correctly, right there, every time the
parent was captured. Three SessionCards captured with three different
statuses each recorded a differently-colored, differently-labeled nested
Badge in their own `evidence.json` — all three were thrown away in favor
of one shared, undifferentiated `external:Badge` reference.

`buildNestedInstanceOverrides(el)` derives up to two `InstanceOverride`
entries directly from the crossed element, mirroring exactly the branch
`mapNode` itself would have taken for this element had it not been
replaced (see the function's own doc comment for the three cases: bare
leaf-text root, `<img>` root — deliberately left alone, since that's
`buildInstanceOverridesFromPerInstanceData`'s image-slot-matching job at
merge time, not evidence-capture time — and frame root, boxed or not).
This reuses the `overrides?: InstanceOverride[]` field ADR-0018 already
put on every instance node; no schema change, and `renderNode.ts`'s
`applyInstanceOverrides` already reads it generically regardless of
nesting depth.

## Decision 3: instances of a resolved componentSet are assigned to the correct captured variant, not left on the default

Verifying Decision 1 and 2 by actually re-running `merge_design_ir_checkpoints`
against the real on-disk checkpoints (not just the analyzer-level unit
tests) surfaced a third, distinct bug with the same visible symptom:
`mergeDesignDocuments`'s external-ref resolution
(`node.componentRef = { kind: "variant", componentSetId: target.id,
variantId: target.variants[0].id }`) has no per-instance information to
go on, so it defaults *every* instance of a resolved componentSet to
`variants[0]`. Even with Decision 1's border-color fix, all three
StatCards in the real merged Dashboard pointed at the same `neutral`
variant — the fix to *what color a variant has* doesn't help if every
instance is pinned to the same variant regardless of its own data.

`packages/core/src/merge.ts` adds:

- `assignVariantsFromPerInstanceData(targetComp, primaryComponents, items,
  tag, warnings)` — pure, returns `{ instanceNodeId: variantId }`. For a
  componentTag whose target resolved to a componentSet, matches each
  item's field(s) against the componentSet's own `variantProperties`
  names/values (the same `perInstanceData` already built for text/image
  overrides — e.g. StatCard's `tone`, SessionCard's `status`) and records
  which already-captured variant that instance should point at. An
  unmatched value is left on its current variant and reported in
  `warnings`, exactly like an unmatched text/image field.
- `applyVariantAssignments(components, assignments)` — the actual
  mutation, exported and applied by `mergeDesignIrCheckpointsTool` as the
  last step. It's a separate, pure-map step rather than an in-place
  mutation during derivation because `mergeDesignIrCheckpointsTool` may
  run `mergeDesignDocuments` a second time (combining derived + explicit
  `instanceOverrides`) — a full fresh clone that would silently discard
  an earlier in-place mutation. Instance node ids are stable across
  repeated merges of the same primary/dependencies (`cloneComponent`
  never renames them), so the same assignment map is valid to apply once,
  against whichever merge result ends up final.

This reuses the existing componentSet/variantAxes architecture exactly as
Issue.md §8 required — no new variant framework, no Design IR change.

## Consequence found only by end-to-end verification, not unit tests

While writing `packages/figma-plugin/test/dashboardRealPipelineIntegration.test.ts`
against a real `.rfd` produced by the fixed pipeline (no hand-supplied
`instanceOverrides`), the SessionCard/Badge assertions passed immediately
but the StatCard border assertion did not — not because Decisions 1–3
were wrong, but because `test/fakeFigma/createFakeFigma.ts`'s
`createInstance()` never copied the master component's own top-level
`fills`/`strokes`/`strokeWeight` onto the created instance (only its
*children* got this, via `cloneForInstance`). Real Figma instances
inherit a master's own properties automatically; this test double didn't
simulate that for the instance root itself, so any earlier test asserting
style on an instance's root (rather than a child, or a path relying on an
explicit override) would have had the same blind spot. Fixed by copying
those three fields alongside the properties `createInstance()` already
copied (`width`/`height`/`cornerRadius`/`children`).

## Consequences

- `StatCard`'s and `SessionCard`'s checkpoints needed regenerating from
  their own unchanged `evidence.json`/`interpretation.json` (same capture,
  fixed construction code) — no other checkpoint changed.
- A component with a plain (non-componentSet) dependency, or with no
  `perInstanceData` at all, is unaffected by Decision 3 —
  `assignVariantsFromPerInstanceData` is a no-op unless the target
  actually resolved to a componentSet.
- Verified against the real Dashboard: `merge_design_ir_checkpoints` run
  with only `perInstanceData` (STATS/SESSIONS taken verbatim from
  `examples/sample-react-app/src/screens/Dashboard.tsx`, no hand-crafted
  `instanceOverrides`) now produces three genuinely distinct StatCard
  borders and three genuinely distinct Badge fills/text — see
  `dashboardRealPipelineIntegration.test.ts`.

## What this deliberately does not do

- No new checkpoint/diff/variant/workflow system — Decision 3 reuses the
  same componentSet/variantAxes/instance-override architecture ADR-0018
  and ADR-0019 already built.
- No hardcoding of `StatCard`, `Badge`, `tone`, `status`, or any specific
  color — all three fixes operate on the evidence/component shape
  generically.
- Does not attempt a per-side stroke *color* (only per-side *width*,
  which Figma already supports via `strokeWeights`) — a border that
  genuinely differs in color at the *same* width on multiple sides
  remains a known, accepted limitation (unchanged from ADR-0018).
