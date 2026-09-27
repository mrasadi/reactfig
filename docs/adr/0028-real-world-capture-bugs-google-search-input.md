# ADR 0028: Real-world capture bugs found testing source-less generation against google.com

## Status

Accepted. Found from an actual user-run capture (not a synthetic
fixture) — the first time source-less generation (ADR 0027) was
exercised against a real, non-React, third-party page rather than the
clean fixtures every existing test uses. Two distinct bugs, fixed
separately below. Both fixes were verified by the full existing test
suite (720 tests, all packages) passing unmodified, plus new targeted
tests; NEITHER fix could be verified against a live re-capture of
google.com itself — this sandbox has no network access to real websites
(only package registries, see the network configuration). The
correction was instead verified by stripping the exact bug symptom out
of the user's own already-captured (broken) Design IR and re-rendering
it through the same, now-effects-aware exporter — same code path,
reconstructed input.

## Bug 1: inlined `<style>`/`<script>` tag content captured as visible text

### Symptom

Exported SVG contained literal CSS source (`.hvhmMe{margin:auto}...`)
rendered as `<text>` elements, positioned at large negative coordinates
(e.g. `x="-429" y="-363.56"`) — clearly not real component content.

### Root cause

`collectDomSnapshot.ts`'s `walk()` recursed into `Array.from(el.children)`
unconditionally — every element child, with no filtering by tag. Google's
homepage inlines scoped `<style>` tags directly inside the DOM subtree
being captured (common for CSS-in-JS/scoped-style approaches; this
repository's own fixtures, all hand-authored React components, never
happened to include one). Walking into a `<style>` element:

1. `directTextContent(styleEl)` read its single text-node child — the
   raw CSS source itself — as if it were the element's visible text.
2. `styleEl.getBoundingClientRect()` returned `{0,0,0,0}`, because a
   `<style>` element is never rendered/boxed — nothing about the capture
   code distinguished "genuinely zero-size" from "not a visual element at
   all".
3. Downstream, `renderSvg`'s `resolveRoot` translates every node's bounds
   into export-root-relative space by subtracting the root's own
   position — for a real (non-degenerate) node this is exactly right,
   but for a `{0,0,0,0}` node whose "position" was never meaningful in
   the first place, it just produces some other arbitrary (here,
   large-negative) coordinate. The renderer wasn't "wrong" given its
   input; the input should never have existed.

### Fix

`collectDomSnapshot.ts` gained a `NON_VISUAL_TAGS` set (`style`,
`script`, `template`, `noscript`, `link`, `meta`, `title`, `head`,
`base`, plus the SVG-internal definition containers `defs`, `symbol`,
`clipPath`, `mask`, `marker`, `pattern`, `metadata`, `desc`) and a
`visualChildren(el)` helper that filters them out BEFORE `walk()`
recurses — so none of them, or anything nested only inside them, is ever
walked into or can become a Design IR node. This is a capture-layer fix,
not a renderer-layer one: the correct number of "real" nodes reaching
the exporters is now smaller, rather than the exporters trying to guess
which nodes to distrust.

### Rejected: filtering at the renderer instead of at capture

Considered — e.g. `svg.ts`/`html.ts` skipping any text node whose
`bounds` is exactly `{0,0,0,0}`. Rejected as the primary fix: it would
have masked the symptom in this one exporter while leaving the same
polluted evidence flowing into everything else that reads
`ComponentEvidence`/Design IR (the AI interpretation step itself, the
`.rfd`/JSON exports, a human reading `evidence.json` to debug something
unrelated). Filtering at the one place non-visual content actually
enters the pipeline is a smaller, more correct fix than filtering it
back out at every consumer.

### Verification

Could not be verified by a real re-capture (no network access to
google.com from this sandbox). Verified instead:

- The filtering logic itself, in isolation, against plain fake-element
  objects mirroring the exact tag-exclusion check (no DOM dependency of
  its own).
- By constructing the exact bug's symptom directly at the Design-IR
  level (a zero-size text node with CSS-looking `characters`) as a
  regression marker test in `@reactfig/artifact`'s exporter test suite,
  documenting what the fix prevents from ever being produced.
- Reconstructing what the user's actual capture would have looked like
  with the bug's symptom manually stripped, and re-rendering that
  through the real (built) `renderSvg` — confirmed no more garbled
  off-canvas text.

`collectDomSnapshot.ts` itself already carried (pre-ADR-0027) a disclosed
limitation that it can't be unit-tested in this sandbox at all (needs a
real browser DOM) — that limitation is unchanged and is not something
this fix could remove.

## Bug 2: `renderSvg`/`renderHtml` silently ignored `effects` (drop shadow)

### Symptom

After Bug 1's fix is applied (mentally — via the reconstruction above),
the resulting SVG has zero visible content: every shape is `fill="none"`
with no stroke. Google's search box's actual visible "pill" outline very
plausibly comes from `box-shadow` rather than a `background-color`/
`border` on any of the specific DOM nodes captured.

### Root cause

Distinct from Bug 1, and found while investigating it: the Design IR
schema already has an `effects?: Effect[]` field on `FrameNode`/
`ShapeNode`/`ImageNode` (`dropShadow`/`innerShadow`/blur), and
`collectDomSnapshot.ts` already captures `box-shadow` as part of its
computed-style evidence — but `@reactfig/artifact`'s `renderSvg`/
`renderHtml` (ADR 0027) never read `node.effects` at all. This is a
genuine gap in ADR 0027's own exporter implementation, not a capture bug:
every existing exporter test used fixtures with no `effects` populated,
so the gap had no failing test to catch it.

### Fix

- `svg.ts`: `collectFilterDef` builds one SVG `<filter>` (with an
  `<feDropShadow>` primitive per shadow effect) per node that has
  `dropShadow`/`innerShadow` effects, collected into a `<defs>` block
  emitted once at the top of the document; the node itself gets
  `filter="url(#shadow_<nodeId>)"`. `innerShadow` is approximated as an
  outer shadow too (SVG's `feDropShadow` has no direct inset
  equivalent) — closer to "there's a shadow here" than rendering
  nothing, documented as an approximation in the function's own doc
  comment, not silently treated as exact.
- `html.ts`: `boxShadowCss` maps the same effects onto a plain CSS
  `box-shadow` (multiple effects comma-joined), with `inset` for
  `innerShadow` — CSS has a direct native equivalent here, no
  approximation needed.
- `layerBlur`/`backgroundBlur` effects are deliberately still not
  rendered by either exporter (documented in both functions' doc
  comments) — no dependency-free, deterministic way to reproduce a
  backdrop Gaussian blur composite in plain SVG/CSS without a reference
  to whatever sits behind the element, judged disproportionate for v1
  given how rare it is on real UI compared to drop shadows.

### What this fix does NOT establish

Whether `effects`/non-text `fills` being entirely absent from THIS
specific capture's Design IR (not just the shadow, every shape in the
whole document has no fill or effect at all) is itself a further,
separate bug in the AI interpretation step that builds the Design IR
from captured evidence — as opposed to Google's specific selected DOM
subtree genuinely having no background/border/shadow on any of ITS OWN
nodes, with the visible pill shape actually coming from a shadow on some
ancestor outside the captured selection boundary. Distinguishing these
needs the actual `evidence.json` (raw computed-style capture) for that
selection, which was not available — only the final `.rfd`/`.svg`
outputs were. Left as an open question for a future investigation with
the underlying evidence in hand, rather than guessed at here.

**Resolved — see "Bug 3" below.** The user re-ran the capture after this
ADR's fixes and supplied `interpretation.json`, which answered this
directly: `nodeAnnotations: []`, and a `notes` field reading `"(tool-call
budget of 2 reached before the model signaled completion)"`. It was
never an evidence-availability question — the AI interpretation step was
being cut off almost immediately, on every real (non-trivial) capture,
by a budget that had silently regressed to less than half its own
documented value.

### Verification

`renderSvg`/`renderHtml` tests added with a synthetic `dropShadow` (and,
for HTML, `innerShadow`) effect on a `session-card` fixture's root frame,
asserting the `<filter>`/`feDropShadow`/`filter=` attributes (SVG) and
`box-shadow:`/`inset` (HTML) are actually emitted. Full existing exporter
test suite re-run and passing, confirming the change is additive (no
`effects` present → no `<defs>` block at all, verified explicitly).

## Bug 3: `MAX_TOOL_ITERATIONS` had silently drifted to less than half its documented default

### Symptom

`nodeAnnotations: []` and `variantAxes: []` in a real interpretation
result, with `notes` explicitly reading `"(tool-call budget of 2 reached
before the model signaled completion)"` — the AI interpretation step
terminated almost immediately, before annotating a single node, which is
the direct cause of Bug 2's "every shape has no fill" symptom: there's
nothing wrong with capturing effects/fills once the model actually gets
to look at the evidence and respond — it just never got the chance to.

### Root cause

`packages/analyzer/src/ai/interpret.ts` defined `export const
MAX_TOOL_ITERATIONS = 2`. Every other reference to this default —
`packages/mcp/src/toolSchemas.ts`'s own code comment, its
`maxToolIterationsSchema` zod description shown directly to MCP clients
("Tool-calling iterations per interpretation attempt (default 5, capped
at 8)..."), and ADR 0013's own addendum ("`maxToolIterations` is now
capped at 8 (default 5)") — agreed the intended default was **5**. The
constant itself had drifted to **2** with nothing to catch the
disagreement: `toolSchemas.ts`'s own doc comment explains it was
"extracted from server.ts... specifically so these limits have a
regression test", but that regression test (`toolSchemas.test.ts`)
checked the schema's bounds were self-consistent, never that the
analyzer's own default actually matched what the schema's description
promised callers.

At 2 iterations, the model gets its first turn (full DOM tree, computed
styles, screenshot — already generous per the schema's own description)
plus exactly one more before being forced to finalize — nowhere near
enough for a real, non-trivial page's search box, which is presumably
why every hand-authored test fixture in this repository (simpler, and
run against `MockModelProvider`s that don't naturally spend iterations
the way a real model does) never surfaced this.

### Fix

`MAX_TOOL_ITERATIONS` corrected from `2` to `5`, matching every piece of
documentation that already described it as `5`. Its own doc comment now
states plainly that it MUST stay in sync with `toolSchemas.ts`'s
description — and `packages/mcp/test/toolSchemas.test.ts` gained a new
test that imports `MAX_TOOL_ITERATIONS` from `@reactfig/analyzer`
directly and asserts it equals `5` (and separately, that it falls inside
the schema's own valid range) — the exact cross-package check that was
missing, so this specific value can't silently drift again without a
test failing immediately.

### Verification

Full analyzer + mcp test suites re-run and passing (721 tests
workspace-wide), including the new cross-package consistency test. Could
not be verified by a real re-capture of google.com (no network access
from this sandbox) — but the fix is a one-line constant correction with
a direct, legible causal chain to the reported symptom (a `notes` field
naming the exact budget that was exhausted), not a guess.
