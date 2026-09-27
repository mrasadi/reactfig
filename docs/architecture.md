# Architecture

## Principles

1. **Determinism first.** Anything derivable from source/DOM/CSS is computed,
   never estimated by a model. AI is used for semantic interpretation,
   variant/ambiguity resolution, and mapping — not geometry.
2. **The Design IR is our contract, not Figma's.** `packages/core` defines
   `design-ir/v1` independently of the Figma API shape, so the renderer can
   change (or a second renderer for another tool can be added) without
   touching the IR.
3. **The renderer never asks the AI anything.** IR → Figma nodes is a pure,
   deterministic transform (`packages/figma-plugin/src/code`). This
   separation is what makes the artifact reproducible and debuggable.
4. **Local-first, no hosted backend.** Everything — browser inspection, MCP
   server, model calls, artifact generation — runs on the developer's
   machine. The only network calls are whatever the configured model
   provider requires; this is documented per-provider.
5. **No Figma MCP dependency**, anywhere, ever, including as a hidden
   fallback. See `docs/adr/0003-figma-plugin-split-architecture.md` for how
   the plugin achieves native output without it.

## Pipeline stages

### 1. Inspection → Evidence Model (`packages/analyzer`)

- **Browser layer** (Playwright, Chromium only): navigates to the running
  app, locates the target component's root DOM node(s), and extracts DOM
  tree, bounding boxes, `getComputedStyle` results, fonts, image assets, and
  a cropped screenshot of the component's bounding box (plus, optionally, a
  lower-priority full-page screenshot for layout context).
- **AST layer** (`ts-morph`, TS Compiler API under the hood): parses the
  component's `.tsx` source for its name, resolved prop types (via the
  semantic type checker), and the JSX tree as written. Union-typed props
  (`variant: 'primary' | 'secondary'`) are surfaced as *candidate* variant
  axes — corroborating evidence, not ground truth.
- Deterministic outputs from both layers are merged by
  `buildComponentEvidence()` into a `ComponentEvidence` document — the
  **Evidence Model** — before anything is sent to a model. This is a
  distinct, versionable stage, not a transient intermediate value; see ADR
  0006. It's plain, JSON-serializable data so it's inspectable/debuggable
  on its own.
- Evidence deliberately preserves more than `design-ir/v1` uses today — for
  example, raw CSS Grid template/placement values are captured in full even
  though the IR's v1 fallback for Grid is absolute positioning (ADR 0002) —
  so a future IR version can use it without re-touching the inspection
  layer.

### 2. AI orchestration (`packages/model` + `packages/analyzer/src/ai`)

- `ModelProvider` interface: `generate`, `generateStructured`,
  `generateWithTools`, `analyzeImage`, each gated by an explicit
  `capabilities` flag rather than assumed.
- `interpretComponent()` is the only model-facing stage: an optional
  tool-calling loop (one consolidated `get_evidence` tool) over a pruned
  initial evidence bundle, then one `generateStructured` call producing a
  narrowly-scoped `ComponentInterpretation` (variant confirmation,
  decorative-collapse decisions, naming — never geometry/color/spacing).
- `buildDesignIR()` is deterministic and never calls a model — it pulls
  bounds/color/typography/etc. directly from `ComponentEvidence` and
  consults the interpretation only for what evidence can't answer.
- `generateDesignIR()` validates the result against `@reactfig/core`'s
  schema and runs a bounded repair loop (default 2 retries) on failure.
- See `docs/analyzer/ai-orchestration.md` and ADR 0008 for the full design.

### 3. Design IR (`packages/core`)

- Versioned at `design-ir/v1`, validated with JSON Schema.
- Node kinds (v1): `Document`, `Page`, `Frame`, `Group`, `Text`, `Shape`,
  `Image`, `ComponentDef`, `ComponentSet`, `Variant`, `Instance`.
- Layout: flexbox-equivalent auto-layout properties only (direction, gap,
  padding, alignment). CSS Grid content is represented as a `Frame` with
  absolutely-positioned children computed from bounding boxes — documented
  as a known v1 limitation rather than faked as auto-layout.
- Every node carries an optional `source` block (`file`, `export`, prop
  snapshot) for traceability back to React — foundation for future sync,
  not a sync system itself.
- Deferred to v1.1: variables/tokens, multi-state capture beyond the states
  actually rendered during inspection.
- **Deterministic JSON utilities** (`stableStringify`, `stableParse`,
  `sortKeysDeep`) — project-wide convention for "write JSON to disk in a way
  that byte-identical inputs always produce byte-identical output." Used by
  both `@reactfig/artifact`'s pack() and the MCP checkpoint layer (ADR 0015).

### 4. Artifact (`packages/artifact`)

- `.rfd` = a zip containing `manifest.json` (artifact version, generator
  version, root component identity, per-asset embedding status),
  `ir.json` (the Design IR document, asset paths rewritten to be
  artifact-relative and self-contained), and `assets/` (embedded bytes for
  any asset `pack()` was given bytes for).
- `pack(doc, options)` / `unpack(bytes)` / `checkArtifact(bytes)` /
  `inspect(unpacked)` — see `docs/adr/0009-artifact-format.md` for the
  determinism, asset-embedding, and validation design.
- Deterministic given identical input: sorted-key JSON serialization via
  `@reactfig/core`'s `stableStringify` (shared with the checkpoint layer;
  see ADR 0015), fixed zip entry timestamps/platform metadata. The one
  genuinely non-deterministic field (`manifest.createdAt`) is explicit and
  injectable, kept separate from the design payload.
- Validated independently of provenance — `unpack()` never trusts an
  artifact it didn't just generate itself, even one produced by an earlier
  version of this same pipeline.

### 5. MCP server (`packages/mcp`)

Small, intentional tool surface (consolidated from the original brief —
the list below is the actual registered surface in `packages/mcp/src/
server.ts`; see `packages/mcp/README.md` for full per-tool detail):

- `inspect_component_source(sourceFile, exportName?)` — AST-only
  structural/prop info. No browser, no model.
- `generate_design_ir(sourceFile, url, selector, ...)` — orchestrates
  browser capture → AST inspection → evidence assembly → AI interpretation
  → a validated `design-ir/v1` document, for one component at a time. A
  nested component referenced by the target (e.g. `Avatar` inside
  `SessionCard`) is left as an `external:<n>` placeholder — this tool
  never resolves a nested component's own definition, only flags where one
  belongs. Each generation persists its major stages (evidence,
  interpretation, design-ir, validation) to a versioned checkpoint
  directory under `.reactfig/checkpoints/<component>/v<N>/` — a new
  generation for the same component never overwrites a previous one; the
  result includes `checkpointDir`, `checkpointVersion`, and
  `checkpointRef` (e.g. `"SessionCard@v2"`) for locating and addressing
  it (ADR 0017).
- `merge_design_ir_documents(primary, dependencies)` — resolves those
  `external:<n>` placeholders by folding in separately-generated
  `generate_design_ir` documents for each nested component, passed
  inline as full JSON. Required before `export_design_artifact` for any
  component with nested sub-components, or their instances render as
  blank placeholder boxes in Figma.
- `merge_design_ir_checkpoints(primaryCheckpointId,
  dependencyCheckpointIds)` — the checkpoint-native counterpart: same
  resolution logic, but reads each document from a checkpoint reference
  (a component name for its latest version, or `"Name@vN"` for a specific
  version) instead of requiring the caller to pass full documents
  inline, persists the merged result as its own versioned checkpoint
  with a manifest recording exactly which input refs it merged, and —
  unless `exportArtifact: false` — packages it into a `.rfd` in the same
  call (ADR 0016, ADR 0017).
- `export_design_artifact(document, outputPath?, checkpointRef?)` —
  packages a validated (and, if needed, already-merged) Design IR
  document into a portable `.rfd` and writes it to disk. The handler
  enforces an explicit serialize→deserialize round-trip on the incoming
  document before validation (ADR 0015), ensuring any fields dropped at
  the MCP boundary surface as real design-ir/v1 errors rather than
  opaque TypeErrors. `merge_design_ir_checkpoints` calls this same logic
  in-process when `exportArtifact` isn't set to `false`, so a merge +
  export can complete in one tool call (ADR 0016). The optional
  `checkpointRef` parameter is pure bookkeeping (ADR 0017): if given, it
  marks that checkpoint's manifest `export` stage completed and updates
  `checkpoint-map.json`, with no effect on the artifact and no failure
  if the reference doesn't resolve.
- `diff_design_ir(before?, after?, beforeCheckpoint?, afterCheckpoint?)`
  — semantic, id-matched comparison of two Design IR documents (never a
  generic JSON diff — see `@reactfig/core`'s `diff.ts`), addressable
  either as inline documents or as checkpoint references, so comparing
  two checkpoint versions of the same component never requires pasting
  either document inline. Returns structured, categorized diff entries
  plus a human-readable report (ADR 0017).
- `validate_design_ir(document)` — schema validation, returns
  errors/warnings. A standalone debugging tool for a hand-constructed or
  hand-edited document — the other tools already validate internally.

### 5.5 Checkpoint versioning, the checkpoint map, and Git awareness (`packages/mcp`)

Checkpoints (§5 above) are versioned per component
(`.reactfig/checkpoints/<component>/v<N>/`, never overwritten by a later
generation) rather than one flat per-request directory. Each version has
a small `manifest.json` — component, source file, a `sha256:` content
hash of that file at generation time, the Git commit when available,
which pipeline stages completed, validation result — answerable without
opening the larger evidence/design-ir files beside it.
`.reactfig/checkpoint-map.json` is a small, disposable, regeneratable
index over all components' latest manifests, purpose-built for fast
resume: a new session can read one small file to learn what exists and
what stage it reached, rather than scanning every checkpoint directory.
Git awareness (`packages/mcp/src/git.ts`) is optional enrichment only —
every checkpoint/staleness/diff operation works identically with no Git
repository present. See ADR 0017 for the full design.

### 6. Figma plugin (`packages/figma-plugin`)

Split architecture forced by the Plugin API sandbox (see ADR 0003),
implemented per the concept-by-concept mapping in `docs/figma-plugin/
feasibility.md`:

- `ui.tsx` (iframe, real browser context): file picker, unpack/validate via
  `@reactfig/artifact`'s `checkArtifact`/`unpack`/`inspect` (reused
  directly — no Node-only dependency blocked this, so no duplicate parsing
  layer was written), artifact summary, base64-encodes asset bytes,
  `postMessage` to the sandbox.
- `code.ts` (sandboxed main thread, `src/code/render/`): two-pass
  deterministic renderer — `buildComponents()` (components/variants via
  `figma.combineAsVariants`) then `renderNode()` (frame/group/text/shape/
  image/instance dispatch, with `loadFontAsync` font-loading and a
  deterministic Inter fallback). Never touches the network or filesystem;
  zero AI calls. See ADR 0011 for the architecture decisions and two
  corrections found during the feasibility review (bounds coordinate
  space, `counterAxisAlign:"stretch"`).

## Interactive Capture Mode (optional, opt-in — `packages/mcp/src/collection/`)

An alternate, explicitly opt-in way to produce the evidence
`generate_design_ir` needs, for when the exact component instance/state
you want is easier to reach by clicking through the running app than to
describe as a `url`/`selector` up front (behind a login, several clicks
into a flow, after an API call settles). Everything downstream of
evidence acquisition is completely unchanged — see "Collection → existing
pipeline" below. Full rationale and alternatives considered: ADR 0026.

**Lifecycle**: `created → collecting → finalizing → completed`. A
collection (`.reactfig/collections/<id>/manifest.json` — a sibling of
`.reactfig/checkpoints/`, deliberately not nested under it: a collection
is pre-pipeline raw evidence, a checkpoint is processed pipeline state,
and they are never the same system) is created by `start_interactive_capture`,
grows as the developer confirms selections (`collecting`), and is sealed
by `finalize_interactive_capture` (`finalizing` → `completed`). Once
`completed`, no more selections can be added, and the browser is no
longer a dependency of anything that follows.

**The browser is a capture surface, not an AI environment.** No model
interpretation happens while the browser is open. A small injected
overlay (`collection/overlayScript.ts`, Shadow-DOM isolated, off the
page's own render tree) shows a DevTools-style hover highlight and a
confirm/parent/child/cancel preview; the developer drives all navigation,
authentication, and application interaction themselves.

**Component-boundary resolution** (`@reactfig/analyzer`'s
`resolveComponentBoundary`) generalizes the same React-fiber `_debugOwner`
walk `findComponentInstances.ts` already uses for name-based lookup, run
in the opposite direction: outward from one already-known DOM node (the
overlay's clicked target) to the nearest enclosing component-instance
root. A production build or plain non-React DOM degrades gracefully to
the raw clicked element (`componentPath: null`) rather than failing —
the overlay's "↑ Parent"/"↓ Child" buttons re-run the same walk one step
out/in as a manual correction, rather than the tool guessing harder.

**Evidence is captured at confirm time, not at finalize time.** When the
developer clicks Confirm, Node (never the overlay itself) drives a real
`collectDomSnapshot` + `Locator.screenshot()` against the live page
(`collection/collectionBrowser.ts`) and `CollectionSession.captureSelection`
persists both atomically before the manifest is updated to reference
them. This is the single decision that makes "browser optional after
finalize" true: nothing about the selection is deferred or reconstructed
later from a selector that might not resolve the same way twice.

**Multiple pages, multiple selections, multiple application states** all
belong to one collection — selections are grouped by their own recorded
`url`, not assumed to share one. Removing a selection marks it
`"removed"` rather than deleting it (same "never delete a completed unit
of work" convention as checkpoint versioning), so the manifest stays an
honest record of everything that was ever selected.

**Collection → existing pipeline**: `generate_design_ir_from_capture`
(`tools/generateDesignIrFromCapture.ts`) is the entire integration point.
It resolves a selection's persisted `RawDomSnapshot` into a `RenderCapture`
via the same `interpretDomSnapshot` function every live capture already
uses (`collection/collectionCapture.ts`), then calls the completely
unmodified `generateDesignIrTool` with that as its `captureComponent`.
Source inspection, AI interpretation, Design IR construction,
checkpointing, merge, and export are the exact same code path a normal
`generate_design_ir` call runs — there is no second pipeline, no mode
switch inside `generateDesignIrTool` itself, and no new checkpoint/diff/
variant system.

**Recovery**: every selection is persisted incrementally, so a browser
crash mid-collection loses at most whatever was mid-confirm at that
instant — everything captured before it stays on disk. `CollectionSession.resume`
reopens an existing collection purely by reading its manifest back off
disk, so a restarted OpenCode/Claude Code process (or a second
`get_interactive_capture_status`/`finalize_interactive_capture` call from
a different request than the one that started the session) reaches the
same durable state without needing any in-memory continuity.

**What isn't verified here**: the browser-facing half of this feature
(the injected overlay actually surviving SPA navigation, hover/click
behavior, Shadow DOM isolation against a real app's own styles) has not
been exercised against a real browser — this sandbox has no network
access to a Playwright browser binary, the same disclosed limitation as
the rest of this repository's Playwright-dependent code (ADR 0023, the
Phase 7 report). Everything that doesn't require an actual browser —
manifest lifecycle, `CollectionSession`'s persistence and resume-after-
restart, the fiber-walk boundary resolution, and the full start → select
→ remove → navigate → finalize → `generate_design_ir_from_capture`
workflow with a fake browser attachment standing in for Playwright — is
tested (`packages/mcp/test/collection/`, `packages/mcp/test/tools/
interactiveCapture.test.ts`, `packages/analyzer/test/browser/
resolveComponentBoundary.test.ts`). See ADR 0026's Status section.

## Output Intent, source-less generation, and agent continuation

See ADR 0027 for the full design and its rejected alternatives; this is
a short pointer for where each piece actually lives.

**Output Intent** — `CollectionManifest.output` / `CollectionSelection.output`
(`collection/types.ts`), resolved by `resolveOutputFormat` (override →
collection default → `"rfd"`). The overlay's confirm-preview panel
(`collection/overlayScript.ts`) exposes a `<select>` for it per
selection. `Design IR -> Output selection -> Renderer/Exporter`
(`@reactfig/artifact/src/export/`: `renderJson` / `renderSvg` /
`renderHtml` / `renderOutput`) is the actual dispatch; the new MCP tool
`export_design_output` is the entry point most callers use, with
`export_design_artifact` itself left completely untouched as a `"rfd"`-
only convenience wrapper still working exactly as it always did.

**Source-less Design IR generation** — `generate_design_ir`'s `sourceFile`
is optional (`tools/generateDesignIr.ts`); omitting it requires
`componentName` + `sourceFingerprint` instead of running
`inspectComponentSource`, and swaps in a synthetic, clearly-marked
"no source" `ComponentSourceEvidence`. Both the sourced and source-less
paths converge on the exact same `buildComponentEvidence` →
`generateDesignIR` → Design IR v1 pipeline — there is no second IR
schema and no second pipeline. `generate_design_ir_from_capture`
(`tools/generateDesignIrFromCapture.ts`) is what most callers actually
use for this: when its own `sourceFile` is omitted, it derives
`sourceFingerprint` automatically by hashing the selection's persisted
`evidence.json`, and `componentName` from the selection's own recorded
`componentPath` when not given explicitly.

**Agent Continuation** — `collection/continuation.ts`'s persisted
`continuation.json` (written by the overlay's new "Done / Continue"
button, via `collectionBrowser.ts`'s `__reactfigMarkDone`) is the durable
signal; `get_interactive_capture_status`'s `continuationPending` /
`continuationSignaledAt` is how a polling agent observes it — the same
poll-don't-block shape ADR 0013 already established for this whole
feature area. `ContinuationBridge` is an additional, optional, in-process
push on top of the persisted signal, not a replacement for it. A
strictly opt-in, non-default keystroke-emulation fallback
(`continuationKeystrokeAdapter.ts`) exists for agent surfaces with no
other way to resume — see ADR 0027's own honest disclosure of what that
can't do from inside this repository alone.

## Repository layout

```
packages/core/            design-ir types + JSON Schema, deterministic JSON (stableStringify/stableParse)
packages/model/           ModelProvider interface + adapters
packages/analyzer/        Playwright + AST inspection, AI orchestration
packages/artifact/        .rfd packaging/unpacking
packages/mcp/             MCP server + pipeline checkpoint persistence
packages/figma-plugin/    ui.tsx + code.ts, separate esbuild target
examples/sample-react-app/  Button, Input, Card, SessionCard, sidebar, one screen
examples/sample-artifacts/  pre-generated .rfd files for the plugin's own tests
docs/adr/                  numbered architecture decision records
```

## Roadmap / phase status

- [x] Phase 1 — architecture, repo structure, ADRs
- [x] Phase 2 — Design IR schema + validator (`@reactfig/core`, ADR 0005)
- [x] Phase 3 — React/browser inspection → Evidence Model (`@reactfig/analyzer`, ADR 0006)
- [x] Phase 3.5 — ComponentEvidence contract review: source↔rendered mapping (componentPath/isComponentRoot), typography/layout/asset gaps closed (ADR 0007)
- [x] Phase 4 — AI orchestration: ComponentEvidence → validated Design IR via ModelProvider, tool-calling, bounded repair (`@reactfig/analyzer/src/ai`, `@reactfig/model`, ADR 0008)
- [x] Phase 5 — portable `.rfd` artifact: pack/unpack/inspect, deterministic packaging, asset embedding, golden fixtures, full-chain round-trip (`@reactfig/artifact`, ADR 0009)
- [x] Phase 6.5 — MCP server (`@reactfig/mcp`, ADR 0010)
  - [x] implement MCP adapter (thin — no analyzer/AI/IR/artifact logic duplicated)
  - [x] expose analyzer capabilities (`inspect_component_source`)
  - [x] expose AI analysis (`generate_design_ir`)
  - [x] expose artifact generation (`export_design_artifact`)
  - [x] project-scoped execution (`--project`/`REACTFIG_PROJECT_ROOT`, resolved once at startup)
  - [x] MCP tool schemas (zod, verified against the real `@modelcontextprotocol/sdk` v1.30 types)
  - [x] error handling (thrown errors propagate with specific messages; asset-fetch failures are non-fatal warnings)
  - [x] MCP integration tests (41 tests, including `merge_design_ir_documents` — tool orchestration + a chained `generate_design_ir` → `export_design_artifact` pipeline test)
- [x] Phase 6 — Figma plugin + deterministic IR renderer (`@reactfig/figma-plugin`, ADR 0011)
  - [x] feasibility matrix documented (`docs/figma-plugin/feasibility.md`)
  - [x] plugin builds for real (`node build.mjs` verified, not merely assumed)
  - [x] manifest valid (`documentAccess: "dynamic-page"`, `networkAccess: {allowedDomains:["none"]}`)
  - [x] React UI builds; sandbox (`code.ts`) builds
  - [x] `.rfd` import + validation (reuses `@reactfig/artifact` directly, no duplicated parsing layer)
  - [x] Design IR rendering: frame/group/text/shape/image/instance, layout (flex + absolute/Grid-fallback), typography with font-fallback, components/variants via `combineAsVariants`
  - [x] embedded assets work from the artifact alone (no network, no dev server)
  - [x] errors/warnings surfaced to the UI; missing components/assets get labeled placeholders, never fabricated content
  - [x] pure renderer tests (47) + artifact integration tests (5) pass — 52 total
  - [ ] **real Figma runtime — not verified** (no live Figma instance available in this sandbox; see `packages/figma-plugin/README.md`, "What's tested here, and what isn't")
- [~] Phase 7 — real end-to-end validation — **attempted, blocked on environment access; full report + manual procedures in `docs/e2e/phase7-report.md`**
  - [x] sample application (`examples/sample-react-app`) — built, typechecks, and builds for real (`npm install && tsc -b && vite build`, verified in this session)
  - [ ] real browser capture — blocked: no network access to `cdn.playwright.dev` in this sandbox
  - [ ] real model smoke test — blocked: no model API key or local inference server configured
  - [ ] vision A/B evaluation — blocked (depends on real model access)
  - [x]/[ ] real artifact — the packaging/inspection tooling (`pack`, `unpack`) was verified for real, including generating an actual `.rfd` (`docs/e2e/SessionCard.demo.rfd`) end-to-end through `buildComponentEvidence` → `generateDesignIR` → `pack()` from fixture evidence (mocked model only); the full React→**live browser**→AI→IR chain was not, since that requires the blocked browser/model steps
  - [ ] real Figma import/render — blocked: no Figma runtime available in this sandbox
  - [ ] visual comparison / fidelity bug loop — blocked (depends on real Figma import)
  - exact manual procedures for every blocked step are documented in `docs/e2e/phase7-report.md`, section by section
- [x] Phase 8 — open-source release hardening
  - [x] MCP portability/reliability root causes documented with fixes (ADR 0012): `collectDomSnapshot` serialization-boundary bug, `networkidle`→bounded-`load` navigation, project-root precedence, MCP transport audit
  - [x] a real regression bug found and fixed during this pass: `createProviderFromEnv`'s silent `REACTFIG_MODEL_NAME`/`_BASE_URL` defaults defeated its own required-config check (was failing `packages/mcp/test/providerConfig.test.ts`) — defaults removed, both now required
  - [x] the persisting `generate_design_ir` "Request timed out" root-caused for real (ADR 0013): the MCP SDK's own 60-second default client request timeout, not a Playwright issue — confirmed against the SDK's source and independent OpenCode GitHub reports (#8701/#8121/#23096). Fixed with MCP progress notifications, full `REACTFIG_DEBUG` stage-timing instrumentation, and end-to-end `AbortSignal` cancellation — honestly disclosed as necessary-but-client-dependent, not a guaranteed fix, since OpenCode's own timeout-extension support is outside this repository's control
  - [x] a second real bug found while investigating vision support (ADR 0013): the production capture path never actually took a screenshot regardless of `REACTFIG_MODEL_VISION` — fixed; screenshots are now captured exactly when the configured provider has vision capability
  - [x] authenticated dev-app capture documented (`REACTFIG_STORAGE_STATE`, `packages/mcp/README.md` "Authenticated development apps")
  - [x] environment variable audit — see `docs/environment.md`
  - [x] root `.gitignore` added (previously missing entirely); committed `.DS_Store` files removed
  - [x] `examples/sample-react-app/package-lock.json` regenerated against the public npm registry (was pinned to a personal mirror, breaking clean installs)
  - [x] root `pnpm test` now builds first (`pnpm -r run build && pnpm -r run test`) — previously relied on incidental script order and failed on a clean checkout
  - [x] stale doc fixed: `packages/mcp/README.md` claimed "there is no plugin here... Phase 6 is separate and not yet built", contradicting the Phase 6 status above
  - [x] full workspace build + typecheck + test suite verified clean in this session (314 tests, 34 files, 0 failures)
  - [x] a real, filesystem-dependent bug found and fixed: `packages/analyzer/src/evidence/parseBoxshadow.ts` and
    `parsegradient.ts` were all-lowercase on disk while their tests imported
    `parseBoxShadow.js`/`parseGradient.js` (camelCase) and production code
    (`buildDesignIR.ts`) imported the lowercase form — TypeScript/Node
    module resolution is case-sensitive on Linux but not on the macOS
    filesystem this repo was developed on, so the two test files silently
    failed to load (`ERR_MODULE_NOT_FOUND`) on any case-sensitive checkout
    or CI runner, while `tsc`'s build (which only followed the
    correctly-cased production import) stayed green throughout. Renamed
    both source files to the camelCase form the tests already expected and
    updated the one production import; both test files (30 tests combined)
    now run everywhere.
  - [x] `debugLog.ts`'s intentional duplication across `@reactfig/model`
    and `@reactfig/analyzer` (see docs/adr/0013's addendum) consolidated
    into a single implementation in `@reactfig/model`, re-exported by
    `@reactfig/analyzer`'s `index.ts` — no behavior change, no API change
    for `@reactfig/mcp` (which continues to import `debugLog` from
    `@reactfig/analyzer`), one fewer file to keep in sync by hand.
  - [ ] the one manual test in `docs/e2e/phase7-report.md`, C0, remains genuinely unverified — whether the real OpenCode → real target app → real local-model round trip that originally motivated ADR 0013 actually stops timing out — disclosed, not claimed; four further Category-C tests (real browser, real model quality, real Figma, general real MCP client) remain unverified for the same reason

- [x] Phase 9 — pipeline checkpoints and serialization-boundary enforcement
  - [x] deterministic JSON consolidation into `@reactfig/core` (`stableStringify`, `stableParse`, `sortKeysDeep`) — shared between artifact pack() and checkpoint layer, eliminating duplicate implementations (ADR 0015)
  - [x] pipeline checkpoint system (`packages/mcp/src/checkpoint.ts`) — persists evidence, interpretation, design-ir, and validation to request-scoped directories under `.reactfig/checkpoints/` for each generation, with atomic writes and stable JSON serialization (ADR 0015)
  - [x] MCP export serialization-boundary enforcement — explicit `stableStringify` → `stableParse` round-trip on incoming documents before validation, ensuring fields dropped at the transport layer surface as real design-ir/v1 errors rather than opaque TypeErrors (ADR 0015)
  - [x] request-scoped checkpoint directories for concurrent calls — each `generate_design_ir` invocation gets its own directory; result includes `checkpointDir` and `requestId` for locating persisted stages (superseded by versioned per-component directories in Phase 11/ADR 0017 — see below)

- [x] Phase 10 — checkpoint-native merge + auto-export (ADR 0016)
  - [x] `merge_design_ir_checkpoints` tool — merges a primary + dependency documents by their existing checkpoint ids instead of requiring the caller to pass full documents inline, closing the gap ADR 0015 flagged ("does not read checkpoints back during export")
  - [x] merged document persisted as its own checkpoint (`merged-<primaryCheckpointId>/design-ir.json` by default) via the existing `writeDesignIrAndValidation` helper — no new persistence logic
  - [x] optional in-process auto-export straight to `.rfd` in the same call (`exportArtifact`, default true), reusing `exportDesignArtifactTool` directly rather than a second MCP round trip
  - [x] `resolveCheckpointDir` added as the read-only counterpart to `openCheckpointDir` — pure path computation, no directory creation, so a bad checkpoint id fails with `readCheckpoint`'s existing clear error instead of silently creating an empty directory (both renamed/replaced in Phase 11/ADR 0017 — see below)
  - [x] 4 new tests through the real MCP dispatch boundary (`packages/mcp/test/mergeDesignIrCheckpoints.test.ts`): end-to-end merge+export+unpack, default merged-checkpoint naming with export skipped, a missing-checkpoint-id error case, and componentSet/variant resolution — full workspace build + typecheck + `packages/mcp` test suite (54 tests) verified clean

- [x] Phase 11 — checkpoint versioning, checkpoint map, Git awareness, `diff_design_ir` (ADR 0017)
  - [x] versioned checkpoints — `.reactfig/checkpoints/<component>/v<N>/`, one directory per generation; a new run for the same component never overwrites a previous one (`openVersionedCheckpointDir`, replacing Phase 9's flat `openCheckpointDir`/request-scoped layout)
  - [x] checkpoint references — `"Name"` (latest), `"Name@latest"`, `"Name@vN"` — resolved by `resolveCheckpointRef` from directory names only, never by opening checkpoint file contents; used identically by `merge_design_ir_checkpoints` and the new `diff_design_ir`
  - [x] per-version `manifest.json` — component, source file + `sha256:` content hash + Git commit when available, per-stage completion status, validation result; answers "what happened here" without opening evidence/design-ir
  - [x] `git.ts` — optional Git awareness (`getCurrentGitCommit`, `isFileDirty`, `getChangedFilesSince`, `hashFileContent`); every function but the pure content hash degrades to `undefined` rather than throwing when Git/the repo is unavailable
  - [x] `.reactfig/checkpoint-map.json` — small, disposable, regeneratable index over every component's latest manifest, for fast resume without scanning checkpoint directories; `rebuildCheckpointMap` reconstructs it from manifests alone if missing or stale
  - [x] `diff_design_ir` MCP tool — semantic, id-matched Design IR diff (`@reactfig/core`'s new `diff.ts`), addressable via inline documents or checkpoint references (`beforeCheckpoint`/`afterCheckpoint`), so e.g. `"SessionCard@v1"` vs `"SessionCard@v2"` is one call with no document JSON pasted inline
  - [x] `export_design_artifact` gained an optional `checkpointRef` bookkeeping parameter — marks that checkpoint's manifest `export` stage completed and updates the map on success, with no effect on the artifact itself
  - [x] 40 new tests: `diff.test.ts` in `@reactfig/core` (16), `checkpoint.test.ts` versioning/manifest additions (17 total), `checkpointMap.test.ts` (8), `git.test.ts` (9), `diffDesignIr.test.ts` (6), plus additions to `mergeDesignIrCheckpoints.test.ts` and `mcpBoundary.test.ts` — full monorepo suite (330 tests across all 6 packages) verified clean, build and typecheck clean

- [x] Phase 12 — Interactive Capture Mode (ADR 0026)
  - [x] `resolveComponentBoundary` (`@reactfig/analyzer`) — generalizes `findComponentInstances.ts`'s fiber walk to resolve an arbitrary clicked DOM node outward to its nearest component-instance root, with parent/child adjustment; graceful `componentPath: null` fallback for non-React DOM
  - [x] collection data model + lifecycle (`@reactfig/mcp/src/collection/`) — `created → collecting → finalizing → completed`, atomic manifest persistence under `.reactfig/collections/<id>/` (a sibling of, never nested under, `.reactfig/checkpoints/`), evidence + screenshot captured and persisted incrementally at confirm time, removal marks rather than deletes
  - [x] `CollectionSession` — every persistence operation is plain filesystem I/O with no Playwright dependency, so the entire capture-and-persist path, resume-after-restart, and removal/finalize lifecycle is unit-tested without a browser binary
  - [x] browser-injected capture overlay (`collection/overlayScript.ts`) — Shadow-DOM isolated, DevTools-style hover highlight + click-to-select + confirm/parent/child/cancel preview + floating selection log; talks to Node only through `page.exposeFunction`, never owns persistence itself
  - [x] four new, strictly opt-in MCP tools: `start_interactive_capture`, `get_interactive_capture_status`, `finalize_interactive_capture`, `generate_design_ir_from_capture` — zero changes to `generate_design_ir`'s existing schema, behavior, or checkpoint semantics
  - [x] pipeline integration is one function (`collection/collectionCapture.ts`) that adapts persisted evidence into `generateDesignIrTool`'s existing, completely unmodified `captureComponent` contract — no second pipeline, no mode-switching inside `generateDesignIrTool` itself
  - [x] 36 new tests across `@reactfig/analyzer` (`resolveComponentBoundary.test.ts`, 9) and `@reactfig/mcp` (`collection/collectionManifest.test.ts` 12, `collection/collectionSession.test.ts` 9, `collection/collectionCapture.test.ts` 2, `tools/interactiveCapture.test.ts` 4 — the last one a full start → select → confirm → second selection → remove → navigate → third selection → review → finalize → `generate_design_ir_from_capture` workflow test) — full monorepo suite (669 tests across all 6 packages) verified clean, build and typecheck clean, zero regressions against the pre-existing 633
  - [ ] **real-browser verification of the overlay — not done** (no network access to a Playwright browser binary in this sandbox, same disclosed limitation as Phase 7/ADR 0023): hover highlighting, Shadow DOM isolation against a real app's own styles, and survival across real SPA navigation (React Router `pushState`/`popstate`) all need real-browser QA before production use — see ADR 0026's Status section and `packages/mcp/README.md`'s "What's tested here, and what isn't"

- [x] Phase 13 — Output Intent, source-less Design IR generation, agent continuation (ADR 0027)
  - [x] Output Intent — `CollectionManifest.output` / `CollectionSelection.output`, `resolveOutputFormat`, overlay output picker, new `export_design_output` MCP tool (all four formats), `export_design_artifact` itself untouched
  - [x] `@reactfig/artifact` gained `renderJson`/`renderSvg`/`renderHtml`/`renderOutput` — all consume the existing Design IR directly, no second document representation; instance/override expansion (`export/resolveTree.ts`) shared by SVG and HTML
  - [x] source-less Design IR generation — `sourceFile` is optional on `generate_design_ir` and `generate_design_ir_from_capture`; capture-inferred evidence is marked in `ComponentEvidence.meta.limitations`, reusing the existing gap-disclosure mechanism rather than a new provenance framework
  - [x] Agent Continuation — overlay "Done / Continue" button, persisted `continuation.json` (`collection/continuation.ts`), in-process `ContinuationBridge`, `get_interactive_capture_status` surfacing `continuationPending`/`continuationSignaledAt`; a documented, strictly opt-in, not-wired-in-by-default keystroke-emulation fallback for agent surfaces with no other resume mechanism (`continuationKeystrokeAdapter.ts`)
  - [x] 87 new tests: `@reactfig/artifact/test/export/exporters.test.ts` (13), `@reactfig/mcp/test/tools/exportDesignOutput.test.ts` (6), `@reactfig/mcp/test/collection/outputIntent.test.ts` (5), `@reactfig/mcp/test/tools/generateDesignIrSourceless.test.ts` (5), `@reactfig/mcp/test/tools/interactiveCaptureSourceless.test.ts` (2), `@reactfig/mcp/test/collection/continuation.test.ts` (10) — plus every pre-existing test across all 6 packages re-run and passing unmodified (715 tests total workspace-wide: `@reactfig/core` 61, `@reactfig/model` 35, `@reactfig/artifact` 38, `@reactfig/analyzer` 284, `@reactfig/figma-plugin` 82, `@reactfig/mcp` 215); full workspace build, typecheck, and test suite verified clean, zero regressions
  - [ ] **real-browser verification of the new overlay UI (output picker, Done/Continue button) — not done**, same disclosed limitation as Phase 12: no Playwright browser binary available in this sandbox. The generated overlay script's syntax was checked (`node --check` against `buildOverlayScript()`'s actual output) but it was not loaded into a real page. See ADR 0027's Status section.
  - [ ] **the keystroke-emulation fallback adapter could not be verified beyond "it's a documented extension point that does nothing until wired up"** — there is no OpenCode/Claude Code process in this sandbox to target, and by design it throws unless a caller supplies their own environment-specific implementation; see ADR 0027, "Honest limitation".


Note on Phase 6/6.5 ordering: the MCP server (6.5) was implemented before
the Figma plugin (6) because it's the piece that turns everything through
Phase 5 into something a real MCP client can actually drive end-to-end —
`.rfd` generation was previously only reachable by calling
`@reactfig/analyzer`/`@reactfig/artifact` functions directly in a test.
Phase 6 has since been implemented (see above) — the renderer consumes the
same `.rfd` artifact `@reactfig/mcp`'s `export_design_artifact` produces,
with no Figma-specific fork of that format.
