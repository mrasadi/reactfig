# ADR 0007: ComponentEvidence review — corrections and deliberate non-changes

## Status
Accepted

## Context
Before starting Phase 4 (AI orchestration), the `ComponentEvidence` contract
from Phase 3 was reviewed against ten specific concerns: source↔rendered
mapping, component boundaries, responsive evidence, visual evidence,
typography, layout, assets, typed-vs-raw CSS values, AI context size, and
debuggability. The instruction was explicit: correct only real gaps, do not
redesign what already works.

Full rationale per concern is in `docs/analyzer/evidence-model.md`. This
ADR records the decision and the corrections made.

## Decision

Six real gaps were found and fixed:

1. **No source↔rendered mapping at all below the component root.**
   Added `componentPath`/`isComponentRoot` on every `ElementEvidence`, via
   React's fiber `_debugOwner` chain (the same mechanism React DevTools
   uses for its Components panel) — best-effort, dev-build-only, bounded,
   documented as such. This was the most substantial addition in this
   review and the one most directly requested.
2. **`RenderCapture` had no slot for a page-level context screenshot**,
   even though `docs/architecture.md` already described one as part of the
   Vision strategy. Added `contextScreenshot` (optional, secondary) and
   `viewportLabel` (structured, alongside the existing free-text `label`).
3. **`fontStyle` (italic) was entirely absent from typography evidence**,
   despite `design-ir/v1`'s `Typography` type already having an `italic`
   field with nothing upstream to populate it. Added, plus `whiteSpace`/
   `textOverflow` for wrapping fidelity and parsed-px siblings for
   `lineHeight`/`letterSpacing`.
4. **`margin` was missing** from layout evidence entirely (only `padding`
   existed) — added, same shape as padding.
5. **`zIndex` was missing** — needed to resolve stacking order for
   overlapping absolutely-positioned siblings. Added, captured only when
   set to a real value (not `"auto"`).
6. **Corner radius discarded its raw CSS string once parsed**, inconsistent
   with `ColorEvidence`'s established raw+parsed pattern used everywhere
   else. Changed `borderRadiusPx: number|tuple|null` to
   `cornerRadius: { raw, parsedPx }`.

One asset-evidence gap, partially addressed: CSS `background-image` had no
structured URL extraction (only the raw CSS string) — added
`backgroundImageUrl`. Natural dimensions for background images were **not**
added (would require an async image load inside a currently-synchronous
DOM walk); documented as an intentional, disclosed gap.

Concern #9 (AI context size) was resolved as documentation + a design
decision, not code: `ComponentEvidence` is already scoped to one component,
which is the right unit; a compression/pruning system was explicitly not
built now, but `componentPath`/`isComponentRoot` were noted as the
structural hook a future pruning pass would use. See
`docs/analyzer/evidence-model.md` §9 for the full strategy.

## Explicitly rejected additions (to avoid over-engineering)

- **Absolute-position offset fields** (`top`/`right`/`bottom`/`left`) —
  rejected as redundant: every node's `bounds` is already a
  viewport-relative rect, so relative placement is recoverable by diffing
  against an ancestor's bounds without duplicating the same information in
  a second form.
- **An instance-ID/dedup scheme for repeated elements** — rejected;
  ordinary tree position (parent-child array order) already distinguishes
  repeated instances (e.g. multiple `Badge`s in a list) without needing a
  synthetic identifier.
- **Structured multi-layer box-shadow parsing** — rejected for now; real
  parsing complexity (comma-separated shadows with nested-paren color
  functions) for a "where practical" bar not yet met. Raw string preserved,
  documented as a standing v1 policy in `meta.limitations`, not silently
  dropped.
- **A compression/pruning implementation for Phase 4** — rejected per
  explicit instruction not to build one yet; documented as a strategy
  instead (§9 above).

## Consequences

- `meta.limitations`' componentPath-related entry was rewritten, since the
  old text ("no DOM-to-JSX mapping beyond the component root") became
  inaccurate once componentPath shipped — a stale limitation is worse than
  no limitation, since it actively misleads whoever reads it.
- `browser/collectDomSnapshot.ts`'s `page.evaluate` call signature changed
  from a single `selector: string` argument to a
  `{selector, rootComponentName?}` object — a small, contained breaking
  change to an internal, not-yet-consumed-by-anything-external API.
- Test/fixture updates: `test/fixtures/raw-snapshots/*.json` gained
  `componentPath` values reflecting realistic fiber-owner chains for the
  existing Button/SessionCard fixtures; a new `hero-banner.json` fixture
  covers the background-image-asset case. 24 new/updated assertions were
  added across `interpretDomSnapshot.test.ts` and
  `buildComponentEvidence.test.ts` (54 total tests now pass, up from 38).
