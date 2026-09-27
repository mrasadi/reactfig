# ADR 0008: AI orchestration architecture (Phase 4)

## Status
Accepted

## Context
Phase 4 needed to turn `ComponentEvidence` into a validated Design IR
document using a model, while satisfying several hard constraints: the
model must not replace deterministic evidence with visual guessing, the
model layer must stay provider-agnostic, capabilities must be explicit and
discoverable, tool calling should let the model pull evidence on demand
rather than receiving everything up front, and the pipeline needed
deterministic validation boundaries with bounded (not infinite) repair.

## Decision: two-stage pipeline, not six

The brief sketched a six-stage pipeline (understand source → interpret
visual evidence → reconcile → generate IR → validate → repair). We
implemented two stages instead:

```
ComponentEvidence
   → interpretComponent()      [the ONLY model-facing stage — tool-calling loop + structured finalize]
   → ComponentInterpretation   [narrow: variant confirmation, decorative-collapse decisions, naming]
   → buildDesignIR()           [deterministic — never calls a model]
   → Design IR
   → validateDesignIR()        [@reactfig/core, unchanged from Phase 2]
   → repair loop                [bounded, re-runs interpretComponent() with validation errors as context]
```

**Why collapsing was correct, not a shortcut:** Phase 3.5 already gave
every `ElementEvidence` a `componentPath`/`isComponentRoot`. That means
"understand source semantics" and "interpret visual/layout evidence" don't
need two separate model calls — the tool-calling loop in a single
`interpretComponent()` call can pull AST evidence, DOM evidence, and a
screenshot in whatever order the model needs, within one coherent
reasoning session, and "reconcile source + visual evidence" is exactly
what that reasoning session already has to do to answer the interpretation
schema's questions. Splitting it into three model calls would have added
latency and cost without a demonstrated reliability gain — and "the key
requirement is reliable structured reasoning, not maximum number of LLM
calls" was explicit in the brief.

**Why IR generation (the brief's "Stage D") is not a model call at all:**
this is the concrete mechanism behind "AI must not silently overwrite
deterministic facts." `buildDesignIR()` (`src/ai/buildDesignIR.ts`) walks
`ComponentEvidence` directly for every geometric/visual property — bounds,
colors, padding, typography, border, corner radius — and consults
`ComponentInterpretation` only for the three things evidence genuinely
can't answer: which prop combinations are real design variants, which
wrapper elements are decorative noise, and human-readable names. A model
that hallucinated a color would have no path to get it into the IR — there
is no field in `ComponentInterpretation` for colors. This is a stronger
guarantee than "instructing the model not to" — it's structurally
impossible for the interpretation schema to carry deterministic facts at
all.

**A second, unplanned consequence of Phase 3.5's componentPath work:**
nested-component boundary detection (collapsing an Avatar/Badge subtree
into an `Instance` node) turned out to need *no AI input whatsoever* —
`isComponentRoot` plus comparing `componentPath`'s nearest owner to the
captured root component name is enough, deterministically. This further
narrowed what the model actually needs to decide, which is part of why two
stages were sufficient. See `src/ai/buildDesignIR.ts`'s nested-component
detection block.

## Tool surface: one consolidated tool, not seven

The brief listed candidate tools (inspect_source, inspect_element,
inspect_nested_component, inspect_responsive_capture, inspect_asset,
inspect_screenshot, compare_viewports) but explicitly invited
consolidation. We implemented exactly one: `get_evidence(kind, ...)`,
`kind` ∈ `{source, element, nested_component, viewport_capture, asset,
screenshot}`. `compare_viewports` needed no dedicated tool at all — calling
`get_evidence(kind:"viewport_capture")` twice and comparing the results is
sufficient; a dedicated comparison tool would only save the model one
function name, not any real capability. `validate_ir` was not exposed as a
model-callable tool either, because the model never drafts raw IR in this
design (see above) — there is nothing for the model to validate before
`buildDesignIR()` runs. This is a case where the "consolidate if a smaller
tool surface is better" instruction and the "IR drafting is deterministic"
decision reinforce each other.

## Evidence selection: depth/boundary pruning, not retrieval

`buildInitialBundle()` (`src/ai/evidenceBundle.ts`) sends: full detail for
the target component and its direct content, one-line summaries in place
of nested-component subtrees (using the same `isComponentRoot` boundary
detection `buildDesignIR` uses), capture *metadata* only (label,
viewportLabel, propValues, root layout mode — not full DOM) for every
other capture, and the primary screenshot only. A text flag
("Layout mode differs across captures: desktop=grid, mobile=flex") is
included whenever captures disagree, but the *screenshot* for the
non-default capture is not force-attached — the model can request it via
`get_evidence(kind:"screenshot")` if the text flag isn't enough. No vector
database, no retrieval index — the entire mechanism is "recurse depth-first
and stop recursing at a component boundary," which was already cheap and
deterministic once `componentPath` existed.

## Structured output and capability handling

`generateStructured` is a **required** capability for
`generateDesignIR()` — a provider without it throws immediately with a
clear message rather than the orchestrator attempting to parse
free-text JSON out of a completion. `toolCalling` and `vision` are
optional and branched on explicitly in `interpretComponent()`: no
tool-calling capability skips straight to a single structured call using
only the initial bundle; no vision capability never attaches an image
part, even when a screenshot exists. Every branch has a test asserting the
skipped path was actually skipped (`test/ai/interpret.test.ts`,
"capability branching").

## Anti-hallucination for variants: schema constraint + hard runtime check

`buildComponentInterpretationSchema()` (`src/ai/schema.ts`) constrains
`variantAxes[].propName` to an enum of exactly the props evidence marked as
variant-capable (a union of string literals). Because JSON-Schema `enum`
support varies across providers/subsets, this is enforced a second way,
unconditionally, in `interpret.ts`'s `enforceVariantEvidence()`: after the
model responds, every `variantAxes` entry is filtered against the actual
`literalValues` evidence recorded for that prop, and any unsupported value
is dropped — never added to, only ever narrowed. `buildDesignIR()` then
only emits a `ComponentVariant` for a prop combination that has an actual
matching capture (`selectVariantCaptures()`) — an axis value the model
confirms but no capture ever exercised produces zero fabricated variants,
per the brief's explicit example (`variant: "primary" | "secondary"` with
only a primary capture must not invent a visual secondary).

## Provenance

Kept intentionally compact, per the brief's explicit "do not pollute every
property" instruction: each `VariantAxisInterpretation` carries a
one-sentence `rationale`; each `NodeAnnotation` carries an optional
`rationale`; `ComponentInterpretation.notes` carries free-text reasoning
and — when the tool-call budget was hit — an automatic note to that effect.
There is no per-IR-property provenance tag; "why did ReactFig decide this
was a variant" is answerable from `variantAxes[].rationale` plus which
captures fed `selectVariantCaptures()`, which is enough without a
node/property-level metadata scheme.

## Reliability: bounded repair, not an agent loop

`generateDesignIR()` runs `interpretComponent()` → `buildDesignIR()` →
`validateDesignIR()`; on failure, validation errors are folded into a
`repairContext` string appended to the system prompt for one more full
`interpretComponent()` call (which re-runs its own bounded tool loop from
scratch). Default `maxRepairAttempts: 2` (so at most 3 total
interpretation calls) — configurable, never unbounded. If the budget is
exhausted, `generateDesignIR()` returns the last attempt with
`validation.valid === false` rather than throwing, so a caller can inspect
exactly what's wrong. Tested in `test/ai/orchestrate.test.ts` — including
the "gives up and returns the invalid attempt" and "maxRepairAttempts: 0
means no repair" edge cases.

## Testing

97 tests total in `@reactfig/analyzer` (up from 54 after Phase 3.5), all
against `MockModelProvider` — zero network calls, zero real model
dependency in the default suite:

- `test/ai/evidenceStore.test.ts` — query engine correctness.
- `test/ai/evidenceBundle.test.ts` — pruning behavior, screenshot
  selection, layout-mode-difference flagging.
- `test/ai/interpret.test.ts` — tool-calling loop mechanics, iteration
  budget, capability branching (toolCalling off, vision off/on),
  anti-hallucination enforcement.
- `test/ai/buildDesignIR.test.ts` — deterministic construction: evidence-backed
  variants, no-fabrication guarantee, geometry/color/typography sourced
  from evidence not interpretation, nested-instance collapsing, CSS Grid
  fallback, asset registration, node-annotation naming.
- `test/ai/orchestrate.test.ts` — end-to-end with Button (variants) and
  SessionCard (nested composition) fixtures, capability-error case, and
  the full repair-loop behavior including a genuine validation failure
  (empty node name) that a real interpretation could plausibly produce.

A separate opt-in smoke test (`scripts/smoke-test-real-model.ts`) runs
`generateDesignIR` against a real configured provider — Ollama/Qwen 3.6 by
default, or Anthropic via an env var — and is not picked up by `vitest
run` (filename doesn't match the test-file glob). Documented in
`docs/analyzer/ai-orchestration.md`.

## Known limitations

- **Nested-component instances reference a placeholder `componentId`**
  (`external:<Name>`) rather than a real cross-referenced `ComponentDef` —
  `generate_design_ir` only ever analyzes one component per call, so it
  never has the nested component's own definition to reference.
  `design-ir/v1`'s schema doesn't enforce referential integrity on
  `componentId`, so this validates cleanly but is a known incompleteness,
  not a hidden one. Resolving it still requires a separate
  `generate_design_ir` call per nested component (true multi-component
  batch orchestration — running those calls automatically — remains a
  later-phase concern) but combining the results is no longer manual: the
  `merge_design_ir_documents` MCP tool
  (`@reactfig/core`'s `mergeDesignDocuments`) takes the primary document
  plus one document per nested component and resolves every matching
  `external:<Name>` ref to the real component, folding both into one
  document ready for `export_design_artifact`. A ref with no matching
  dependency is left as `external:<Name>` and reported in the result's
  `unresolvedExternalRefs`, so the incompleteness stays visible rather
  than silently producing a blank instance in Figma. `export_design_artifact`
  also re-checks the document it's given for any remaining `external:<Name>`
  ref immediately before packing (`@reactfig/core`'s
  `findUnresolvedExternalRefs`) and reports the same thing as a warning —
  covering the case where `merge_design_ir_documents` was skipped
  entirely, not just an incomplete merge — so this is visible at export
  time rather than only after a Figma import.
- **box-shadow and CSS `linear-gradient()` backgrounds ARE translated**
  into structured `Effect`/`Fill` values (`parseBoxShadow.ts` /
  `parseGradient.ts`, wired into `mapFrameNode`) — both are pure parses
  of evidence already captured verbatim (ADR 0007), not fabricated
  structure. What's still genuinely unsupported, catalogued rather than
  silently dropped:
  - **`radial-gradient()` / `conic-gradient()`** — now supported (see
    `docs/adr/0022-conic-gradient-and-multi-layer-backgrounds.md` and
    `docs/adr/0021-hardening-for-arbitrary-react-components.md`), with the
    same "approximate, not pixel-verified" caveats as the linear-gradient
    angle handling this section describes.
  - **`repeating-linear-gradient()`** — no "repeat" concept in the
    schema.
  - **A background stack beyond the first layer** — now supported (see
    `docs/adr/0022-conic-gradient-and-multi-layer-backgrounds.md`), which
    also found and fixed an independent bug: fills were being pushed in
    CSS order (image/gradient, then color), but Figma's `fills` array
    paints LATER entries on top — so background-color was rendering over
    the image/gradient instead of under it, for every component that had
    both, regardless of layer count.
  - **CSS `filter: blur(...)` / `backdrop-filter`** — not in
    `COMPUTED_STYLE_PROPERTIES`'s capture allow-list at all
    (`collectDomSnapshot.ts`), so `layerBlur`/`backgroundBlur` — despite
    being fully supported by both the schema and the figma-plugin
    renderer — can never be produced today regardless of mapping code.
  - **Non-uniform borders — all four sides are sampled** (`border-top-*`,
    `border-right-*`, `border-bottom-*`, `border-left-*` are all in
    `COMPUTED_STYLE_PROPERTIES`, `collectDomSnapshot.ts`) and mapped by
    `mapBorder` (`buildDesignIR.ts`) onto Figma's single shared `Stroke`
    by picking the *widest* side's color as the paint source — a
    thicker-than-its-neighbors side is a deliberate accent (a colored
    left-border stripe next to thin neutral borders elsewhere), and this
    is exactly the side whose color is meant to be visible/distinct (see
    docs/adr/0020). Sides of equal width fall back to the first side with
    a resolvable color. A border that genuinely differs in *color* at the
    *same* width on more than one side still can't be represented — that
    part of the original limitation still holds, since `Stroke`/
    `FrameNode.strokes` has no per-side-color concept, only a flat list —
    but it's a narrower gap than "only the top side is ever read," which
    was true at an earlier point in this project and is no longer
    accurate.
  - **`linearGradient.angleDeg`'s exact visual convention is derived,
    not pixel-verified** — see `parseGradient.ts`'s
    `cssAngleToDesignIrAngle` doc comment for the derivation (checked
    against the renderer's own untouched `angleToGradientTransform`
    matrix at two independent angles) and its remaining caveat: Figma's
    real rendering of that transform still can't be confirmed without a
    live Figma instance.
- **Decorative "skip" collapsing only handles single-child wrappers** — a
  multi-child node annotated `skip` is not collapsed (falls back to normal
  frame mapping), documented in `buildDesignIR.ts` rather than attempting
  a more general (and riskier) N-child flattening.
- **The repair loop re-runs the full tool-calling loop from scratch each
  attempt** rather than resuming the prior conversation — simpler and
  safer (no risk of compounding a bad prior turn) at the cost of repeating
  tool calls the model already made once when repair is needed. Acceptable
  given the default budget is small (2 repairs).