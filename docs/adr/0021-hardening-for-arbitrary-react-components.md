# ADR 0021: Hardening for arbitrary React components (v1 release)

## Status

Accepted. This is the "make it work beyond the sample app" pass — a
prioritized response to eight gaps identified while assessing readiness
for arbitrary, real-world React components (not just this repo's own
demo). Each gap was independently investigated against actual code before
deciding whether it needed a fix, a partial fix, or was already handled —
two turned out to be less severe than initially assessed, which is
recorded here too, not just the fixes.

## Fixed

**Component-boundary detection: `React.memo`/`forwardRef`.**
`componentDisplayName` (duplicated, deliberately, in `collectDomSnapshot.ts`
and `findComponentInstances.ts`) previously only checked `type.displayName`/
`type.name`. Both wrappers' actual component lives one level deeper
(`.type` for `memo`, `.render` for `forwardRef`) and rarely has its own
name set, so a memo- or forwardRef-wrapped component's boundary
previously resolved to `null` — indistinguishable from a host DOM element,
meaning the component simply vanished from the captured tree. Now
recurses into `.type`/`.render` (handles a `memo(forwardRef(...))` double-
wrap too). **`createPortal`-rendered content is now detected, not yet
captured.** A portal renders outside its logical parent's DOM subtree
entirely, which position-based capture/instance-matching has no
mechanism for reaching at all — that part is unchanged and is a genuine
v3-or-later item (would need fiber-level `HostPortal` boundary detection
validated against a real React runtime, which building blind in an
environment with no browser access would mean shipping unverified). What
v2 does add: `detectPortalUsage.ts` statically scans a component's own
source for a `createPortal(...)` call (bare or namespaced) and surfaces
it as `usesPortal` on both `ComponentSourceEvidence` and
`DependencyTreeNode` — turning a previously silent, confusing gap (a
component's evidence looks complete but is quietly missing whatever it
portals out) into an explicit, actionable signal a caller can act on
(capture the portaled content as its own separately-targeted component,
since it usually renders as its own recognizable subtree under its
target container once mounted).

**Variant discovery: static (non-`.map()`) repeated usage.**
`discoverVariantCaptures`/`extractMappedDataRefs` only ever found variants
backed by a `.map()` over a literal array — real, but not the only common
pattern (a `<Button variant="primary">`/`<Button variant="secondary">`
pair with no array behind them was previously invisible to discovery
regardless of how differently they rendered). New
`extractStaticUsageVariants.ts` finds repeated JSX call sites of the same
tag in one file and proposes an axis from literal string props that
differ across usages, reusing `discoverVariantCaptures`'s own
`findVariantAxisFields`/`buildVariantCandidates` (factored out for this,
not duplicated) so both mechanisms apply the identical enum-token-shape/
multi-value criteria. Deliberately skips any usage found inside a
`.map()` callback — that's the other mechanism's job, and counting one
static call site executed N times at runtime as N distinct static usages
would be wrong. Surfaced on `DependencyTreeNode.staticUsageVariants`,
alongside (not replacing) `mappedDataRefs`.

**CSS gaps: `filter`/`backdrop-filter` blur, `radial-gradient()`.**
Two independent, narrower-than-fixing-"all CSS gaps" fixes:
- `filter`/`backdrop-filter` weren't even in `COMPUTED_STYLE_PROPERTIES`
  — not captured from the DOM at all, so a component's blur was invisible
  end-to-end regardless of what it used. The design-ir `Effect` union
  already had `layerBlur`/`backgroundBlur` shapes and the Figma-plugin
  renderer already handled them (`style.ts`) — genuinely only a capture-
  and-mapping gap, not a schema one. New `parseBlur.ts` extracts a
  `blur(Npx)` radius from a (possibly chained) filter value; other filter
  functions (`brightness()`, `contrast()`, etc.) still have no
  representable shape and are silently not included — narrower gap than
  before, not a closed one.
- `radial-gradient()` previously had no `Fill` shape at all (a real schema
  gap, correctly flagged as such in ADR-0008). Added `radialGradient` to
  the `Fill` union (types + JSON schema) and `parseRadialGradient.ts`
  (`parseGradient.ts`), same "approximate, not pixel-verified" honesty as
  the existing linear-gradient angle handling: only the gradient's center
  position (`at X% Y%`) is modeled, not shape (`circle`/`ellipse`) or
  explicit radius/size keywords — every radial gradient renders as
  Figma's default circular gradient at the extracted (or default-center)
  position. Renderer support (`GRADIENT_RADIAL` + a translation-only
  `gradientTransform`) added to `style.ts`.

## Investigated, found already adequate — no fix needed

**External/third-party dependencies ("opaque holes").** Actually already
degrades cleanly: `inspect_component_dependency_tree` reports every
unresolved import in its own `unresolved: ImportedComponentRef[]` field
(exactly what a caller needs to know which `external:<name>` refs can
never be resolved by discovering more source), `merge_design_ir_checkpoints`
reports the same at merge time (`unresolvedExternalRefs`), and — the part
that actually matters visually — `renderNode.ts`'s `renderInstance`
already falls back to a clearly named (`⚠ Missing component: <name>`),
correctly sized, correctly positioned placeholder frame with an explicit
warning, and this is already covered by `fallback.test.ts`. The original
assessment ("opaque holes," "silently dropped") was wrong on inspection;
retracted rather than left uncorrected.

**Children/slot composition.** Evidence capture is DOM-based, not
source-based — it has no concept of "this content arrived via
`props.children`" versus "this is a literal JSX child" versus "this is
another component's own composition," and doesn't need one: whatever
actually rendered in the DOM gets walked and mapped the same way,
including recognizing a nested component boundary the same way Badge and
Avatar already are (see ADR-0020). This is already exercised by the
existing SessionCard/Avatar/Badge tests — arbitrary nested content,
however it got there, was never actually the gap. The real, narrower gap
is Figma's own **`instanceSwap` component-properties panel feature**
(letting a *designer*, inside Figma, swap which component fills a slot
via the properties panel) — `ComponentProperty[]` exists in the schema
but `buildDesignIR.ts` never populates it today, so the `instanceSwap`
skip in `components.ts` is presently dead code guarding against a
producer that doesn't exist yet. Worth building eventually (real, if
cosmetic, UX value), not the correctness gap it was assumed to be.

## Explicitly deferred at v2 time — implemented since, see ADR-0023

**Interaction/pseudo-state capture (hover/focus/active).** At the time
this ADR was written, no capture logic anywhere in this codebase
simulated interaction. A follow-up pass (`docs/adr/0023-interaction-
state-capture.md`) implemented it — a new capture-plan shape, Playwright
interaction scripting, and a deterministic `state` variant axis — but
with an explicit, load-bearing caveat that ADR carries forward: the
actual browser-interaction code has NOT been exercised against a real
page (no live-browser access in this environment), unlike everything
else in both ADRs. Read ADR-0023's "Status" section before relying on
this for anything beyond the parts it explicitly marks as tested. The
original reasoning for why this needed its own capture mode (a
capture-plan shape, timing/settle concerns, how a state axis relates to
prop-driven ones) is preserved below since ADR-0023's design follows
directly from it:
isn't a small gap in existing machinery, it's an entire missing capture
mode: a new capture-plan shape (which interaction to perform before
reading computed style), Playwright interaction scripting
(hover/focus/mousedown, with the timing/settle concerns real interaction
simulation has that static capture doesn't), and a decision for how a
"hover variant" relates to the existing prop-driven variant axis (a
different kind of axis entirely — state, not data). Attempting a "minimal
version" of this within this same pass would have meant either a
half-working interaction mode or a fake one; neither would have been
better than documenting it honestly as the highest-value follow-up at
the time — which is exactly what ADR-0023 then implemented, with its own
explicit "unverified against a live browser" caveat rather than pretending
that constraint went away. Portal *capture* (as opposed to the detection
added in this same pass, see above) remains fully deferred — still the
other item most likely to matter for a real component library, where
portaled overlays are part of "the component" as much as any prop-driven
variant is.

## Consequences

- No breaking schema change for existing consumers: `radialGradient` is
  an additive `Fill` variant, `staticUsageVariants`/`usesPortal` are
  additive `DependencyTreeNode` fields — nothing existing had to change
  shape.
- `docs/adr/0008-ai-orchestration.md`'s "Known limitations" section had a
  stale claim (borders were described as top-side-only, when the code has
  captured all four sides for some time) — corrected in the same pass
  that touched border-adjacent code, on the theory that a docs fix found
  while already in the area is cheaper to make immediately than to file
  and lose track of.
- Test suite grew from 567 to 615 across this ADR's fixes (memo/forwardRef,
  static-usage variants, blur, radial gradient, portal detection) — each
  with a fixture built from realistic patterns (a `<Button
  variant="primary">` pair with no backing array, a
  `memo(Component)`/`forwardRef(fn)` fiber shape, a chained `filter`
  value, an off-center `radial-gradient()`, a `createPortal(...)` call
  via both a bare import and a namespace alias), not just the sample
  app's own components. `conic-gradient()` and multi-layer backgrounds
  were addressed in a follow-up pass — see
  `docs/adr/0022-conic-gradient-and-multi-layer-backgrounds.md`.

## What still doesn't handle (see this ADR's notes above, ADR-0023, and ADR-0020's own scope notes)

Full portal *capture* (detection only — see above), interaction/pseudo-
state capture's real-browser verification (implemented but unverified —
see ADR-0023), per-side border *color* (only width), `repeating-*-
gradient()` variants, `instanceSwap` component properties, and Angular/
Vue/Svelte (this pipeline's browser-side component-boundary detection is
built on React's fiber tree; its source-level AST analysis is JSX/TSX-
shaped — both would need a parallel, framework-specific implementation,
not a config flag).
