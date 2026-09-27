# The `ComponentEvidence` contract

This is the reviewed, current shape of the Evidence Model — the contract
between `@reactfig/analyzer` and Phase 4's AI reasoning. Source of truth is
`packages/analyzer/src/evidence/types.ts`; this document explains *why*
each part exists, organized around the review that produced it (see ADR
0007). If you're extending the evidence model, read this before adding a
field — several additions here were deliberately kept minimal to avoid
over-fitting to one hypothetical need.

## Shape

```
ComponentEvidence
├─ componentName
├─ source: ComponentSourceEvidence        (AST — see docs/architecture.md)
├─ captures: RenderCapture[]               (one per rendered state)
│   ├─ label, viewport, viewportLabel?
│   ├─ propValues?                         (which variant/props produced this)
│   ├─ dom: ElementEvidence                (recursive DOM tree)
│   ├─ screenshot: ScreenshotEvidence | null       (component crop — primary)
│   └─ contextScreenshot: ScreenshotEvidence | null (page/context — secondary)
└─ meta: { analyzerVersion, limitations: string[] }
```

`ElementEvidence` (recursive):

```
tag, attributes, textContent, bounds
componentPath: string[] | null            (§1 below)
isComponentRoot: boolean                  (§1 below)
style: StyleEvidence                      (§5, §6, §8 below)
image: ImageAssetEvidence | null          (§7 below)
children: ElementEvidence[]
```

## §1 — Source ↔ rendered mapping, and §2 — component boundaries

Every `ElementEvidence` carries `componentPath`: the chain of component
display names that own it, outermost first (e.g. `["SessionCard",
"Avatar"]`), and `isComponentRoot`, a boolean marking the first DOM node
belonging to a given owner.

This is derived in the browser (`collectDomSnapshot.ts`) from React's fiber
`_debugOwner` chain — the same internal field React DevTools itself reads
to build its Components panel. It answers "which component's JSX created
this element" (authorship), not "which component's rendered DOM subtree
physically contains this element" (containment) — the two differ for
pass-through `children` content, and authorship is what a model needs to
understand composition. It is:

- **Best-effort, not guaranteed.** `_debugOwner` only exists in React
  development builds. Local dev servers (this project's target scenario)
  run in development mode, so this resolves in the common case; it
  degrades to `null` gracefully otherwise — never a crash, never a wrong
  answer presented as certain.
- **Bounded**, via an optional `rootComponentName` passed to
  `collectDomSnapshot` — the walk stops once it reaches the captured
  component itself, so `componentPath` doesn't fill up with app-level
  providers/routers. A hard cap (`MAX_OWNER_DEPTH`) applies regardless.

Together these answer concerns #1 and #2 without Fiber "magic": the target
component, nested components, and ordinary DOM elements are distinguished
by comparing `componentPath` to a parent's; repeated elements/instances are
distinguished by ordinary tree position (two `Badge` instances in a list
get the same `componentPath` but are different array entries) — no
additional instance-ID scheme was added, since tree position already
provides uniqueness and adding one would be scope creep for no real gain.

## §3 — Responsive evidence

Unchanged in spirit from Phase 3, tightened for clarity: each viewport
produces its own `RenderCapture` with its own fully-interpreted `dom` tree
— a component that's CSS Grid on desktop and a flex column on mobile
produces two captures with `dom.style.layoutMode` of `"grid"` and `"flex"`
respectively (see `test/interpretDomSnapshot.test.ts`, "responsive" suite).
Added `viewportLabel` (`"desktop"`, `"mobile"`, ...) alongside the existing
free-text `label`, so callers don't have to parse a convention out of a
string to group captures by viewport programmatically. This stays evidence
— nothing here merges or resolves the two layouts into one IR-shaped
structure; that reconciliation is explicitly Phase 4's job.

## §4 — Visual evidence

`RenderCapture.screenshot` (component-level crop) was already deterministic
and path-referenced, not inlined. Added `contextScreenshot`, optional and
lower-priority, matching the "component-level primary, page-level optional
secondary" policy in `docs/architecture.md`'s Vision section — there was
previously no slot for it even though the architecture doc described it.
A Phase 4 orchestrator can now assemble a model payload as: structured
evidence + `screenshot` (always, if present) + `contextScreenshot` (only
when layout genuinely depends on surrounding content) + `source` — matching
the "structured evidence + relevant screenshot(s) + source info" pipeline
shape requested.

## §5 — Typography

Added: `fontStyle` (italic/oblique — this was a real gap: `design-ir/v1`
already has an `italic` field on `Typography` with nothing upstream to
populate it from), `whiteSpace` + `textOverflow` (wrapping/truncation
fidelity), and parsed-px siblings `lineHeightPx`/`letterSpacingPx` (kept
alongside the existing raw strings — `line-height: 1.5` unitless has no px
form and correctly parses to `null`; `line-height: 24px` does).
`textContent` (direct-only) was already present on `ElementEvidence`; box
dimensions for wrapping come from the existing `bounds`. No new field
needed for "dimensions" — it was already covered.

## §6 — Layout

Added: `margin` (mirrors `padding`'s shape — was missing entirely; matters
for spacing between block-flow siblings that flex/grid `gap` doesn't
cover), `zIndex` (only when set to a real value, not `"auto"` — needed to
resolve stacking order between overlapping absolutely-positioned siblings,
e.g. a badge over an avatar). `position` (`static`/`relative`/`absolute`/
`fixed`/`sticky`) was already captured raw. Explicit offset values
(`top`/`right`/`bottom`/`left`) were considered and deliberately **not**
added: every element's `bounds` is already a viewport-relative rect, so an
absolutely-positioned child's placement relative to its containing block is
already fully recoverable by diffing against the ancestor's `bounds` —
adding raw offsets would duplicate information already present, which is
exactly the kind of unnecessary addition this review was told to avoid.
Still renderer-neutral throughout — no Figma-specific concept anywhere in
`StyleEvidence`.

## §7 — Assets

`<img>` elements were already covered (`src` + `naturalWidth`/`naturalHeight`
+ `alt` — real bytes are fetched from `src` in a later packaging phase, not
inlined into evidence). The gap: CSS `background-image` assets had no
structured representation, only the raw CSS string. Added
`backgroundImageUrl`, parsed out of a `url(...)` reference via
`parseCssUrl` (returns `null` for gradients, so it doesn't falsely claim an
asset exists). Natural dimensions for background images were **not**
added — getting them requires an async image load during what is currently
a synchronous DOM walk, a real complexity jump for a case that's
uncommon at component level (more typical for page-level hero banners,
out of scope for component-level evidence). Documented as an intentional
gap, flagged conditionally in `meta.limitations` when relevant.

## §8 — CSS values: typed alongside raw

Fixed one real inconsistency: corner radius previously discarded its raw
CSS string once parsed. Now `cornerRadius: { raw, parsedPx }`, matching the
`raw`+`parsed` pattern `ColorEvidence` already used. `boxShadow` remains
raw-string-only by explicit decision, not oversight — parsing potentially
multi-layer shadows (comma-separated, with nested-paren color functions)
into structured evidence is real parsing complexity for a "where
practical" bar that isn't met yet; documented in `meta.limitations` as a
standing v1 policy, not silently skipped.

## §9 — AI context size (strategy, not implemented — see ADR 0007)

`ComponentEvidence` is scoped to *one component at a time* by construction
— this is the existing, and correct, unit of context size control. The
concrete risks and the recommended (not-yet-implemented) mitigations:

- **Component-level analysis** (the common case): a single component's DOM
  subtree, typically tens of elements. No change needed.
- **Screen-level analysis**: don't inline full evidence for every nested,
  already-known component. `componentPath`/`isComponentRoot` (§1) exist
  specifically so a future pruning step can collapse a recognized
  component's subtree to a summary (`tag`, `bounds`, `componentPath`,
  "see `Avatar`'s own `ComponentEvidence`") instead of repeating full style
  data for every element inside it. Recommended default: the MCP
  orchestration layer (Phase 4/5) composes a screen export as multiple
  per-component `analyze_component` calls rather than one giant
  `ComponentEvidence`, keeping each payload bounded by construction rather
  than needing a compression pass at all.
- **Repeated elements** (e.g. 20 list items with the same `componentPath`):
  recommended future mitigation is sending full evidence for the first
  occurrence and a compact summary (count + bounds range) for the rest —
  not implemented now; flagged as future work rather than built
  speculatively.
- **Variant × viewport matrix**: capturing every combination multiplies
  `captures[]` fast. Recommendation: the caller (Phase 4 orchestration)
  should capture only the states that are actually ambiguous or visually
  distinct, not a full cartesian product — consistent with "deterministic
  facts first, AI inference second": if two variants render identically
  except for a color the analyzer already resolved deterministically,
  there's no need to spend a second capture (and a second screenshot) on it.
- **Screenshot selection**: `screenshot` (component crop) is sent by
  default; `contextScreenshot` only when layout genuinely depends on
  surrounding content (§4) — already the policy, now that there's a field
  to express it.

No compression system exists yet. This section is the agreed strategy for
when one becomes necessary, so Phase 4 doesn't have to re-derive it.

## §10 — Debuggability

Unchanged principle, strengthened by the above: `ComponentEvidence` is
still plain, JSON-serializable data (round-trip tested in
`test/buildComponentEvidence.test.ts`), and `meta.limitations` is kept
accurate rather than aspirational — the componentPath-related limitation
text was rewritten in this review specifically because the old wording
("no DOM-to-JSX mapping") became inaccurate once componentPath shipped; a
developer reading `meta.limitations` should be able to trust it describes
the *current* gaps, not stale ones.

## What was deliberately not changed

- No text-run/rich-style model added to `Typography` — still deferred per
  ADR 0005/0006, evidence captures one style per element faithfully.
- No semantic Grid model added — still raw-preserved-but-unmodeled per
  ADR 0002.
- No instance-ID/dedup scheme for repeated elements — tree position is
  suffient, adding one now would be speculative.
- No box-shadow structured parsing, no background-image natural
  dimensions, no absolute-position offset fields (redundant with `bounds`)
  — all considered and rejected for the reasons above, not overlooked.
