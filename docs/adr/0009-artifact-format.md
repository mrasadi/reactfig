# ADR 0009: Portable `.rfd` artifact format (Phase 5)

## Status
Accepted

## Context
`@reactfig/artifact` existed only as a package.json/README stub from Phase
1. Phase 5 needed to build the real `pack`/`unpack`/`inspect` pipeline,
decide the manifest's shape, resolve how assets get from evidence-captured
URLs to portable embedded bytes, make generation as deterministic as
practical, and produce realistic golden fixtures — all while keeping the
artifact a clean boundary with zero Figma dependency.

## Decision: manifest.json + ir.json + assets/, nothing else

Per the brief's explicit "add other files only if they materially improve
portability/debuggability" — no `preview.png`, no extra metadata files.
`manifest.json` carries artifact-level metadata (version, root identity,
asset embedding status) that a consumer needs *before* deciding whether to
even parse the full `ir.json`; `ir.json` is the Design IR document itself,
with asset paths rewritten to be self-contained (see "Assets" below).

## Determinism

Three separate sources of non-determinism were identified and addressed:

1. **JSON key ordering.** `manifest.json`/`ir.json` are serialized via a
   `stableStringify` that sorts object keys at every level
   (`pack.ts`), so byte-identical *content* always produces
   byte-identical *bytes*, independent of the input document's key
   insertion order — tested directly (`pack.test.ts`, "produces
   byte-identical output regardless of...key insertion order").
2. **Zip entry timestamps.** JSZip stamps each entry with the current
   wall-clock time unless told otherwise, which would make two `pack()`
   calls with identical content produce different bytes on different
   days. Fixed via an explicit, arbitrary, constant `FIXED_ZIP_DATE` passed
   to every `zip.file(...)` call.
3. **Zip platform metadata.** Zip's "external file attributes" differ
   between DOS and UNIX-style archives depending on the OS that created
   them. Fixed via `generateAsync({ platform: "UNIX" })`, pinned regardless
   of the host OS running `pack()`.

**What stays genuinely non-deterministic, on purpose:** `manifest.createdAt`.
Rather than trying to eliminate it, it's made explicit, top-level,
separate from the design payload, and injectable
(`PackOptions.createdAt`) — exactly the brief's "if metadata such as
creation time is useful, keep it separate...or make its behavior
explicit." Tests that need reproducible output across runs (all of them
except the one specifically checking the default) pass a fixed
`createdAt`.

`doc.meta.generatedAt` (inside `ir.json`, inherited from Phase 4's
`buildDesignIR`) is a second timestamp this ADR does *not* attempt to
strip or freeze — it's the Design IR's own concern (when was this IR
generated), not the artifact's, and `pack()` treats `ir.json` as a payload
to serialize deterministically, not a payload to edit for determinism's
sake. A caller wanting fully diffable `ir.json` output across regenerations
of the same evidence would need to control that timestamp upstream, in
`buildDesignIR`/`generateDesignIR`, not in this package.

## Assets: rewritten to artifact-relative paths, embedded when bytes are available

`AssetRef.path` as produced by Phase 4's `buildDesignIR` is a placeholder —
the original evidence-captured src/URL, explicitly documented at the time
as "not yet resolved to real bytes... a Phase 5 concern." This phase
resolves it: `pack()` accepts `assetBytes: Record<originalPath,
Uint8Array>` and, for every asset with a bytes entry, writes the bytes to
`assets/<id><ext>` inside the archive and rewrites that asset's `path` in
the packed `ir.json` to the new artifact-relative location. This is what
makes the artifact genuinely portable — a future Figma plugin resolves
every embedded asset from the archive alone, per the brief's explicit
requirement, with no access to the developer's React repository or dev
server.

An asset with no bytes provided is **not** a pack failure — it's recorded
honestly in the manifest as `embedded: false`, keeping its original
(unresolved) path. This mirrors the evidence layer's own philosophy of
disclosed limitations over silent failure or fabrication: a caller
inspecting the manifest can see exactly which assets didn't make it into
the portable artifact, rather than the pack silently succeeding with a
now-dangling reference or throwing and blocking the whole export over one
unfetched image. Fetching asset bytes from a dev server is deliberately
**not** this package's job — that's an analyzer/MCP-level orchestration
concern (fetching the URL, deciding whether to retry) kept out of the
packaging layer, which only knows how to embed bytes it's handed.

`design-ir/v1`'s `AssetRef` schema (`additionalProperties: false`, no room
for an `embedded` flag) is why this status lives in the manifest's own
`ManifestAssetEntry`, not in `ir.json` — a deliberate second schema rather
than stretching Phase 2's contract to carry artifact-packaging concerns it
was never scoped for.

## Validation: two entry points, same five checks

`unpack()` (throws on first failure — for callers that want the parsed
result or a hard stop) and `checkArtifact()` (collects every failure — for
tooling like the inspect CLI that wants to report everything at once) both
run: manifest schema, Design IR schema, artifact/IR version compatibility,
asset-reference completeness (every `ir.json` asset has a manifest entry,
every `embedded: true` manifest entry has an actual file in the archive),
and package integrity (valid zip, required files present). Neither
function trusts an artifact it didn't just generate — every check runs
regardless of provenance.

## "Responsive component" fixture: full-chain test, not a static IR fixture

`design-ir/v1` has no per-viewport concept — by the time a Design IR
document exists, `buildDesignIR` has already resolved evidence's multiple
`RenderCapture`s down to one representative layout (Phase 4). A standalone
"responsive" Design IR fixture would therefore be indistinguishable from
any other fixture — there's nothing IR-shape-specific to demonstrate. The
responsive scenario is instead covered by
`packages/analyzer/test/e2e/fullChain.test.ts`, which builds
`ComponentEvidence` from two real viewport captures (desktop CSS Grid,
mobile flex-column — reusing Phase 3.5's fixtures), confirms the
evidence-level difference is real, runs it through mocked AI
interpretation and `buildDesignIR`, and only then packs/unpacks the
resulting single-layout IR. This is a case where "where practical, create
[the full chain]" (the brief's own suggested fallback) was the more honest
choice than inventing an artificial fixture shape.

## Golden fixtures

`packages/artifact/test/fixtures/design-ir/`: `button.json` (a
`ComponentSet`, now with 2 variants — extended from Phase 2's original
single-variant example, which is also `docs/design-ir/example.button.json`'s
canonical reference and stayed in sync with this change),
`session-card.json` (nested `Instance` collapsing + CSS Grid
`layout.mode:"none"` fallback), `avatar.json` (a standalone
image-containing component with a real `AssetRef`, packed against an
actual tiny PNG fixture in `test/fixtures/assets/`, not a placeholder
object). All hand-authored against the actual node/component shapes
`buildDesignIR` produces, not artificial minimal objects.

## Testing

25 tests in `@reactfig/artifact` (`pack`, `unpack`, `checkArtifact`,
`inspect`), plus 2 full-chain round-trip tests added to
`@reactfig/analyzer` (bringing its total to 99, project total 133 across
core/model/analyzer/artifact). The round-trip assertion in both full-chain
tests is `expect(unpacked.document).toEqual(generated.document)` — genuine
deep-equality on the semantic IR, not a byte comparison (byte-identical is
covered separately, at the artifact-bytes level, in `pack.test.ts`'s
determinism suite).

## Known limitations

- **`ir.json`'s own `meta.generatedAt`** is not made deterministic by this
  package — see "Determinism" above. A caller wanting fully diffable
  `ir.json` across regenerations needs to control it upstream.
- **No asset deduplication across separate `pack()` calls** — if the same
  image is referenced from two different components packaged separately,
  each artifact embeds its own copy. Not a problem at today's
  one-component-per-artifact scope; would need revisiting if/when
  whole-screen multi-component artifacts are introduced.
- **`root` in the manifest is always `components[0]`** — matches every
  document Phase 4 produces today (always exactly one top-level
  component/componentSet), but is a simplification that would need
  revisiting for a future multi-component "whole screen" artifact.
- **Zip compression level is fixed at 6**, not configurable — a reasonable
  default, not tuned for either minimum size or minimum CPU; revisit if
  artifact size becomes a real concern.
