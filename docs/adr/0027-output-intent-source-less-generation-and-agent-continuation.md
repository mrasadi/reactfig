# ADR 0027: Output Intent, Source-less Design IR Generation, and Agent Continuation

## Status

Accepted, with the same explicit caveat ADR 0026 already carries for
Interactive Capture, extended to this ADR's own new browser-facing
surface: this environment has no network access to a Playwright browser
binary, so the overlay's new output picker and Done/Continue button
(`collection/overlayScript.ts`) have NOT been exercised against a real
browser. What was verified with a real test run:

- `@reactfig/artifact`'s new `renderJson`/`renderSvg`/`renderHtml`
  exporters and the `renderOutput` dispatcher, against real fixture
  Design IR documents (including instance/override expansion).
- `export_design_output`, including a byte-for-byte comparison against
  `export_design_artifact`'s own `.rfd` output for the same input, to
  confirm it is a superset, not a fork.
- Output Intent persistence/resolution in the collection manifest
  (selection override → collection default → `"rfd"`), including a
  manifest with no `output` field anywhere (pre-existing collections).
- Source-less `generate_design_ir` (no `sourceFile`) end to end, via the
  same fake-capture seam ADR 0026 already established for
  `generate_design_ir`'s own tests — through
  `generate_design_ir_from_capture`, including the automatic
  `sourceFingerprint` derived from a selection's persisted
  `evidence.json`, and `outputFormat` resolution flowing through the
  result.
- The persisted `ContinuationSignal` (`collection/continuation.ts`) and
  in-process `ContinuationBridge`, and `get_interactive_capture_status`
  surfacing both.
- The generated overlay script's syntax (`node --check` against the
  built output of `buildOverlayScript()`), since it's a plain JS source
  string assembled by TypeScript, not itself type-checked.

What was NOT verified: the overlay's new output-picker `<select>` and
Done/Continue `<button>` actually rendering/working in a live page, and
`__reactfigMarkDone` actually closing a real Playwright browser context.
Same shape of gap ADR 0026 already disclosed for the rest of the overlay
— needs real-browser QA before production use.

## Context

Three related gaps, all raised together because they compose (docs
section 22's end-to-end flow touches all three):

1. The only way to choose an output format was the OpenCode/Claude
   prompt text itself (e.g. "generate an RFD artifact") — nothing
   persisted the choice as data, so it couldn't survive past the current
   turn or be recovered by a later `export_design_artifact` call.
2. `generate_design_ir` (and therefore `generate_design_ir_from_capture`)
   unconditionally required a `sourceFile` and ran `inspectComponentSource`
   on it — a component with no accessible React source (a third-party
   site, a component the developer doesn't have checked out) had no path
   to a Design IR at all, even though Interactive Capture already
   collects DOM/CSS/screenshot evidence that's often sufficient on its
   own.
3. Finishing an Interactive Capture session required the AGENT to notice
   and call `finalize_interactive_capture` — nothing let the DEVELOPER,
   from inside the browser itself, say "I'm done" and have that be the
   trigger.

## Decision 1: Output Intent lives on the existing collection manifest, not a parallel system

`CollectionManifest.output?: { format }` (collection-level default) and
`CollectionSelection.output?: { format }` (selection-level override), both
optional, both new fields on structures that already exist —
`collection/types.ts`. `resolveOutputFormat(manifest, selectionId?)` is
the one place the override→default→`"rfd"` precedence is decided; every
caller (the new `export_design_output` tool,
`generate_design_ir_from_capture`'s result) goes through it rather than
re-implementing the fallback chain. A manifest written before this ADR
(no `output` field anywhere) resolves to `"rfd"` for every selection —
exactly what every existing caller already assumed, verified by a test
that constructs such a manifest directly.

## Decision 2: `.rfd`/JSON/SVG/HTML are all renderers of the same Design IR, dispatched by one function

`@reactfig/artifact/src/export/`: `renderJson`, `renderSvg`, `renderHtml`,
and a `renderOutput(doc, format)` dispatcher that also covers `"rfd"` by
calling the existing, completely unmodified `pack()`. No second document
representation was introduced (docs section 6/8) — JSON export is
`stableStringify` (the project's own existing deterministic-JSON
convention) of the Design IR itself; SVG/HTML both resolve the exact same
node tree (`resolveTree.ts`: expands `instance` nodes to their referenced
component/variant root, applies overrides, re-anchors bounds into
export-root-relative space) and differ only in how each node type is
serialized.

`export_design_output` is a new tool, not a modification of
`export_design_artifact` — for `format: "rfd"` it delegates to
`exportDesignArtifactTool` unchanged and was verified to produce
byte-identical output to it for the same input. `export_design_artifact`
itself was not touched at all; every existing prompt/client that calls it
directly keeps working with zero changes (docs section 5/10, Case 10 of
the compatibility matrix).

### Rejected: making SVG/HTML preserve component/instance semantics

Considered and rejected per docs section 9: SVG and HTML have no native
concept of a component instance, only its resolved visual result.
Instance nodes are expanded inline (geometry, fills, text) rather than
referenced, and this is stated as a known, intentional limitation in both
renderers' own doc comments rather than silently implied.

### Known gap: SVG text baseline positioning is an approximation

`svg.ts` positions text using `fontSize * 1.2` as a line-height stand-in
when a Design IR text node has no explicit `lineHeight` — there's no real
text-shaping/metrics engine in this dependency-free exporter. Documented
in the function's own doc comment; visually close but not pixel-exact for
every font.

## Decision 3: source-less generation reuses `generateDesignIrTool` unchanged in shape, not a second pipeline

`sourceFile` became optional on `GenerateDesignIrArgs`
(`tools/generateDesignIr.ts`). When present, behavior is byte-for-byte
identical to before (verified: the full pre-existing
`generateDesignIr.test.ts` suite still passes unmodified). When absent:

- `componentName` becomes required (there's no AST to derive an export
  name from) — a clear, thrown error otherwise, not a silent fallback to
  some guessed name.
- `sourceFingerprint` becomes required — a caller-supplied stable hash
  that plays the exact role `hashFileContent(sourceFile)` already played
  for checkpoint-resumability (ADR 0017 §8): capture-plan revision keys
  and checkpoint manifests are keyed on it either way, so resumability
  doesn't quietly degrade just because there's no file.
  `generate_design_ir_from_capture` computes this automatically by
  hashing the selection's own persisted `evidence.json` (the capture IS
  this generation's "source state", in exactly the role a `.tsx` file's
  bytes play for the ordinary path) — reusing `hashFileContent` unchanged,
  just pointed at a different file.
- A synthetic `ComponentSourceEvidence` (`file: "", jsx: null,
  importedComponents: [], ...`) stands in for `inspectComponentSource`'s
  output. Every downstream consumer (`buildComponentEvidence`, the AI
  interpretation prompt) already reads `jsx: null` /
  `importedComponents: []` as "no source-derived structural
  corroboration available" — no new code path was needed in any of them.

There is exactly one Design IR schema (docs section 12) — source-backed
and capture-backed evidence both flow through the same
`buildComponentEvidence` → `generateDesignIR` → Design IR v1 pipeline.

## Decision 4: provenance reuses `ComponentEvidence.meta.limitations`, no new framework

Docs section 15 asks that an inferred structure never be mistaken for one
React source actually declared. `ComponentEvidence.meta.limitations:
string[]` already exists precisely to record known evidence gaps (see
`buildComponentEvidence.ts`'s own doc comment: e.g. "no DOM-to-JSX
mapping beyond the root"). Source-less generation appends one entry to
it — `"Source-less generation: no React source file was available for
<name>..."` — rather than inventing a confidence score, a provenance
object, or a second field anywhere in the Design IR schema itself. This
was deliberately the smallest change that satisfies the requirement: any
consumer that already surfaces `limitations` (a human reviewing
`evidence.json`, the AI interpretation prompt) sees this exactly the way
it already sees any other disclosed gap.

### Rejected: a dedicated provenance/confidence framework

Considered and rejected as disproportionate for v1 — docs section 15
explicitly asks not to add one "unless genuinely necessary", and
`meta.limitations` already covers the actual requirement (don't imply
source-backed when it isn't).

## Decision 5: Agent Continuation is a persisted signal first, an in-process push second, and never a keystroke by default

`collection/continuation.ts`:

- `writeContinuationSignal(dir)` / `readContinuationSignal(dir)` — a
  small `continuation.json` sibling to `manifest.json`, written once, by
  exactly one caller: `collectionBrowser.ts`'s new `__reactfigMarkDone`
  bridge function, invoked when the developer clicks the overlay's own
  "Done / Continue" button. This is the durable source of truth — a
  process restart, or `get_interactive_capture_status` called from a
  different process entirely, both see it the same way, the same
  "disk is the source of truth" principle the manifest itself already
  follows.
- `ContinuationBridge` — an in-process `EventEmitter` wrapper, scoped per
  `collectionId`, that `server.ts` instantiates once per server process
  and threads through `start_interactive_capture` →
  `attachInteractiveBrowser` → `__reactfigMarkDone`. This is the
  "explicit continuation/control signal" architecture docs section 19
  asks for, preferred over emulating input. It is genuinely optional —
  `writeContinuationSignal` runs regardless of whether a bridge was
  supplied, so nothing is lost if it wasn't.

`__reactfigMarkDone` finalizes the collection (`session.finalize()` —
the exact same call `finalize_interactive_capture`'s MCP tool already
makes, not a second finalize path) BEFORE writing the signal, and writes
the signal BEFORE closing the browser (docs section 20: "the collection
must be finalized/persisted before the browser is closed"). Closing is
gated on `InteractiveBrowserOptions.closeOnDone` (default `true`, matching
`finalize_interactive_capture`'s own default), so a caller that wants the
browser to stay open after Done/Continue for some reason still can.

`get_interactive_capture_status` now also reports `continuationPending` /
`continuationSignaledAt`, read from the persisted marker — so an agent
that polls status (the pattern ADR 0013 already established as the way
to track a long-running Interactive Capture session) sees this the same
way it already sees selection counts, no new polling shape required.

### Honest limitation: this cannot push a new turn into an agent's own conversation

`ContinuationBridge` is genuinely in-process only. Nothing here claims to
interrupt an already-idle agent conversation and make it "continue" on
its own — that would require either (a) an MCP transport that supports
server-initiated notifications the client's own runtime forwards into a
new turn, which this SDK's request/response model (see ADR 0013's own
disclosed timeout constraints — the reason start/status/finalize is
polled in the first place) does not provide, or (b) something environment-
specific that simulates input the surrounding agent runtime happens to
already be listening for.

`(a)` is left as a documented extension point: a future tool could
subscribe to `ContinuationBridge.onceSignaled` and forward it over
whatever transport-level notification the connected client's MCP SDK
supports, once one exists here. `(b)` is `continuationKeystrokeAdapter.ts`
— per docs section 19's own request, implemented ONLY as an explicit,
opt-in, non-default fallback: `emulateContinuationKeystroke` throws unless
the caller supplies their own environment-specific `send` function, and
nothing in this package calls it. This sandbox has no OpenCode/Claude
Code process to target, so this specific piece could not be built or
verified beyond "it's a documented extension point that intentionally
does nothing until wired up" — reported as a known limitation rather than
silently left unimplemented or falsely claimed as working.

### Rejected: making the browser-driven finalize a different code path from the agent-driven one

Considered and rejected — `__reactfigMarkDone` calls the exact same
`session.finalize()` `finalize_interactive_capture`'s tool handler calls.
A second finalize implementation would have meant two places that could
each independently get manifest-locking, `finalizedAt`, or status
transitions subtly wrong.

## Backward compatibility

Verified by the full pre-existing test suites (`generateDesignIr.test.ts`,
`exportDesignArtifact.test.ts`, `interactiveCapture.test.ts`, and every
other pre-existing MCP/artifact/analyzer/core test) passing completely
unmodified, plus:

- `export_design_output` producing byte-identical `.rfd` bytes to
  `export_design_artifact` for the same input (Decision 2).
- A manifest with no `output` field anywhere resolving to `"rfd"`
  (Decision 1).
- `generate_design_ir` with `sourceFile` given behaving identically to
  before (Decision 3) — the pre-existing test suite for it is the proof.

No existing tool's required parameters changed; every new capability is
additive (new optional fields, new tools, one new optional context field
threaded through existing ones).
