# ADR 0011: Figma plugin renderer architecture (Phase 6)

## Status
Accepted

## Context
Phase 6 needed a deterministic renderer turning a validated Design IR
document into native, editable Figma content, inside the constraints of
the actual Figma Plugin API — not an idealized one. `docs/figma-plugin/
feasibility.md` records the full concept-by-concept mapping investigation
this ADR's decisions are based on; this document covers the structural and
process decisions.

## Two corrections found during the feasibility review

Both are detailed in `docs/figma-plugin/feasibility.md`'s "Corrections to
prior assumptions" section and are only summarized here:

1. **`bounds` coordinate space.** Phase 2's doc comment claimed IR bounds
   were parent-relative; they're actually absolute/document-space
   throughout the real pipeline. Corrected the doc comment
   (`packages/core/src/types.ts`) and implemented `relativePosition()`
   (`geometry.ts`) as the one place every renderer function computes a
   Figma `x`/`y` from IR bounds.
2. **`counterAxisAlign: "stretch"` has no Figma parent-level equivalent.**
   Figma's `counterAxisAlignItems` is `MIN|MAX|CENTER|BASELINE` only;
   stretch is a per-child `layoutAlign` property. `applyLayout()` returns
   whether the caller must apply `layoutAlign: "STRETCH"` to each child
   after appending them, since children don't exist yet when the parent's
   layout is configured.

A third, unplanned correction was found only after writing an artifact
integration test against the **real** `@reactfig/artifact.pack()`
(not a hand-built fixture): `pack()`'s deterministic key-sorting (ADR
0009) silently reorders a `ComponentVariant.propertyValues` object's keys
alphabetically, but Figma's variant-name parsing
(`"Property=Value, Property2=Value2"`) is order-sensitive. `variantNodeName()`
now derives property order from the owning `ComponentSet.variantProperties`
array (array order survives JSON round-trips; object key order does not)
instead of `Object.entries(propertyValues)`. This is exactly why the
brief's "artifact integration tests" category matters as its own testing
tier, distinct from pure renderer unit tests with hand-built fixtures —
this bug was invisible to every hand-built-fixture test and only surfaced
once a real pack/unpack round-trip was exercised.

## Decision: two-pass rendering, no retries

Pass 1 (`components.ts`) builds every `ComponentDef`/`ComponentSet` from
`document.components[]` first, populating `ctx.componentIndex`. Pass 2
walks `document.pages[]`, where any `Instance` node resolves against the
now-complete index. This is deterministic by construction — no retry loop,
no deferred-resolution queue — because no document this pipeline currently
produces contains a forward reference from an earlier-defined component to
a later-defined one (see feasibility doc, "Rendering order," for the exact
justification and its limits).

## Decision: one dispatcher, not one file per concept

`renderNode()` (`renderNode.ts`) is the single function every node type
goes through — including a component's own children (`components.ts`) and
top-level page content (`renderDocument.ts`) — so the frame/group/text/
shape/image/instance mapping logic is defined exactly once, not
duplicated per call site. Small focused modules exist for cross-cutting
concerns that multiple node types need (`style.ts` for fills/strokes/
effects/corner-radius, `typography.ts`, `layout.ts`, `assets.ts`,
`naming.ts`, `geometry.ts`) — this matches the brief's "do not create
excessive abstraction... but do not blindly create one file/class per
concept."

## Decision: never invent structure Figma doesn't support

Two fallbacks are exercised and tested, both producing a clearly-labeled
placeholder rather than fabricated content, per the brief's explicit "do
not fake Figma semantics" / "do not silently substitute unrelated content":

- An `Instance` whose `componentRef` isn't in `componentIndex` (typically
  an `external:<Name>` placeholder from ADR 0008, since nested components
  aren't yet separately analyzed) renders as a frame named
  `"⚠ Missing component: <Name>"` with a neutral fill, and a warning.
- An asset with no embedded bytes (`manifest.assets[].embedded === false`)
  renders as a frame/rectangle named `"⚠ Missing asset: <Name>"` with the
  same neutral placeholder fill, and a warning.

An empty `Group` (Figma disallows empty groups) similarly falls back to an
empty `Frame` with a warning rather than throwing and aborting the whole
import — consistent with the typography fallback's "one missing font must
not abort the whole document" principle, generalized to every fallback
case in the renderer.

## Decision: `@reactfig/artifact` reused directly, no portable parsing layer

Investigated whether `pack.ts`/`unpack.ts`/`validateArtifact.ts`/
`inspect.ts`/`manifest.ts` have a Node-only dependency blocking reuse in
the plugin UI (a real, open concern from the original architecture brief).
Found none — only `jszip`/`ajv`/`ajv-formats`/`@reactfig/core`, no
`node:fs`/`node:path`. The plugin UI imports these functions directly,
bundled for the browser via esbuild. No duplicate parsing/validation logic
was written. `@reactfig/core`'s validator (and therefore
`@reactfig/artifact`'s functions that call it) runs exclusively in the UI
iframe, never in the sandbox — the sandbox's more restricted JS engine may
not support `ajv`'s runtime `new Function` code generation, and this was
already the established split from ADR 0003 (Phase 1).

## Decision: base64 asset transfer, UI → sandbox

Figma's `postMessage` channel likely supports typed arrays via structured
clone, but exact behavior (size limits, fidelity) wasn't independently
verifiable here. Asset bytes are base64-encoded for the message payload —
a conservative, well-established pattern for exactly this transport,
avoiding a dependency on an unverified assumption. `shared/base64.ts`
implements chunked encode/decode with a manual fallback (`btoa`/`atob`
aren't guaranteed present in the sandbox's global scope, per the sandbox's
restricted environment).

## Testing

Per the brief's explicit category split:

- **Category A (pure renderer, no Figma)**: 47 tests against
  `test/fakeFigma/createFakeFigma.ts`.
- **Category B (artifact integration)**: 5 tests, real
  `@reactfig/artifact` + real golden fixtures (no Figma-specific copy),
  through the same fake Figma API — this category is what caught the
  variant-naming/key-sorting bug above.
- **Category C (real Figma runtime)**: not executed — see
  `packages/figma-plugin/README.md`, "What's tested here, and what isn't"
  for the precise, itemized boundary. `node build.mjs` was run for real in
  this phase (not merely assumed) and produced genuine `dist/code.js` /
  `dist/ui.html` output, which is as far as "verified" goes without an
  actual Figma instance.

52 tests total (47 + 5), project total 206 across all six implemented
packages.

## Known limitations

Recorded in full in `docs/figma-plugin/feasibility.md`'s matrix and
`packages/figma-plugin/README.md`; not repeated here. The single most
consequential one: visual (pixel-level) fidelity against real React output
is explicitly out of scope for this phase (the brief's own instruction) —
this phase establishes structural correctness, deterministic mapping, and
component semantics only.
