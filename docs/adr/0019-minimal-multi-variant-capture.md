# ADR 0019: Minimal, resumable multi-variant capture

## Status

Accepted. Implements Issue.md's "Implement Minimal Multi-Variant Capture"
task: `generate_design_ir` can now discover and capture a component's
actually-rendered visual variants (e.g. `StatCard.tone`, `SessionCard.
status`) instead of ever capturing exactly one DOM state, and its
capture loop is resumable — a browser/network failure partway through no
longer means starting over from capture 1.

## Context

`generate_design_ir` already supported multi-capture via its `variants`
argument (`VariantCaptureSpec[]`, looped over in the tool) — but nothing
ever populated that argument automatically, and nothing about the loop
was resumable: it captured everything in one in-memory pass and only
persisted anything (`evidence.json` onward) after *all* requested
captures succeeded. A failure on capture 3 of 4 discarded captures 1 and
2 as well. Both gaps are addressed here, reusing existing pipeline
abstractions rather than building new ones (see Issue.md §1/§11).

## Decision 1: discover variants from data already extracted, not from CSS or React execution

`packages/analyzer/src/ast/discoverVariantCaptures.ts` looks only at what
`extractMappedDataRefs` (see ADR-adjacent work resolving Issue.md's
`.map()`-discovery follow-ups) has already found: a component rendered
via `.map()` over a literal array. A prop qualifies as a variant axis when
it's actually passed to the component (present in `mappedKeys`, not just
somewhere in the data shape), string-valued, short and enum-token-shaped
(`/^[a-zA-Z][a-zA-Z0-9_-]{0,23}$/`), and has more than one distinct value
across the mapped instances. One capture candidate is proposed per
distinct combination of axis values actually observed, deduped to its
first occurrence (`instanceIndex`) — never an invented value.

Verified against the real sample app: this discovers exactly `StatCard.
tone` (`neutral`/`success`/`warning`) and `SessionCard.status`
(`completed`/`scheduled`/`missed`) — Issue.md's own two named
verification cases — while correctly rejecting `avatarSrc` (not
enum-shaped), `learnerName`/`scheduledFor` (free text), and `score`
(numeric, and not present on every item).

This is deliberately not a general prop-discovery, CSS-analysis, or React
execution engine (Issue.md §3/§11): a variant this can't tie back to an
actual `.map()`-rendered instance is simply never proposed. Turning a
discovered candidate into an actual browser capture (a selector, e.g.
`:nth-of-type(${instanceIndex + 1})`, targeting that specific DOM
instance) is left to the caller (`Run.md`), consistent with `generate_
design_ir`'s existing `variants` argument already being caller-supplied.

## Decision 2: a capture plan is one more checkpoint file, not a second checkpoint system

`packages/mcp/src/capturePlan.ts` adds the smallest structure needed for
determinism and resume:

- `PlannedCaptureRequest` — a capture's identity (label, url, selector,
  viewport, propValues); deliberately excludes incidental runtime
  settings (`captureScreenshot`, an `AbortSignal`) that don't change
  *what* is captured.
- `computeRevisionKey(sourceContentHash, requests)` / `computeCaptureId
  (revisionKey, request)` — stable SHA-256-derived ids. Same source +
  same requested captures always produces the same ids; a different
  source or a different requested set always produces different ones.
- `CapturePlan` — `{ revisionKey, captures: PlannedCapture[] }`, each
  entry `pending` / `completed` / `failed`.

This plan is persisted as `capture-plan.json`, a new entry in `checkpoint.
ts`'s existing `CHECKPOINT_FILES`, written into the same versioned
directory as `evidence.json`/`design-ir.json`/etc. — not a parallel
mechanism. Each individual completed capture's raw evidence is stored
separately, as its own small file under that version's `captures/`
subfolder (`writeCaptureArtifact`/`tryReadCaptureArtifact`), reusing
`writeCheckpoint`'s exact atomic write-then-rename pattern.

## Decision 3: resume decided by the checkpoint map first, never by rereading every file

`checkpointMap.ts`'s `openOrResumeVersionedCheckpointDir` is the write-side
entry point `generate_design_ir` now calls instead of `openVersionedCheckpointDir`
directly:

1. Check `checkpoint-map.json` for an entry (one file, already loaded for
   every generation). No entry → conclusively a first-ever generation;
   allocate a fresh version, no other file is ever opened.
2. An entry exists → lazily load *only* that component's latest `manifest.
   json` + `capture-plan.json` (two small files) to check: is the
   `capture` stage anything other than `completed`, and does the
   persisted plan's `revisionKey` match this call's freshly-built one
   exactly? If both hold, resume — reuse that same version directory,
   with each entry's persisted status carried over
   (`mergeCapturePlan`). Otherwise, fresh version, same as always
   (ADR-0017 §2's "a new generation never overwrites a previous one" is
   unchanged for the genuinely-new-generation case).

This keeps `checkpoint.ts` → `checkpointMap.ts` a one-way dependency
(ADR-0017 §3: the map is disposable, checkpoint.ts never depends on it) —
the resume logic lives in `checkpointMap.ts`, which already depends on
`checkpoint.ts`, never the reverse.

`generate_design_ir`'s loop itself: for each plan entry, an already-
`completed` one (from a resumed prior attempt) is read back from its
artifact file instead of recaptured; everything else (`pending` or
retried `failed`) is actually captured, persisted (artifact +
capture-plan.json) immediately as it completes — not batched to the end —
and on a thrown capture error, the plan and manifest are patched to
`failed` and **the checkpoint map is updated even on this failure path**
(a real bug caught by this ADR's own test: without it, a failed run never
appears in the map, so a subsequent call's fast map-check in step 1 above
finds nothing and silently starts over instead of resuming).

## Consequences

- A component with no discoverable variants behaves exactly as before —
  one request, one capture, no plan-merge branch ever taken differently.
- `capture-plan.json` and each `captures/<id>.json` are new files in every
  checkpoint version going forward; older checkpoints without them are
  handled (missing plan → treated as non-resumable, falls back to a fresh
  version; a `completed`-marked entry with a missing artifact file is
  defensively recaptured rather than silently producing a hole in the
  evidence set).
- Evidence assembly, AI interpretation, and Design IR construction are
  unchanged — `buildComponentEvidence`/`generateDesignIR` already treated
  a list of same-component captures with different `propValues` as
  variant evidence for one logical component; this ADR only changes how
  that list gets built and how reliably it survives a mid-capture failure.

## What this deliberately does not do

- No CSS parsing, no reverse-engineering a tone→color mapping statically.
- No exhaustive Cartesian-product generation of every theoretically
  possible prop combination — only combinations actually observed
  rendered in the `.map()` data.
- No new persistence layer, no new checkpoint format, no Git integration.
- Variant discovery only ever looks at `.map()`-rendered instances found
  by static AST analysis; a component whose variants are only reachable
  through interactive state (a toggle, a hover) is out of scope, same as
  before this ADR.
