# ADR 0030: Inline `<svg>` icon capture, as an `image` node — no new node type

## Status

Accepted. Same verification caveat as ADR 0027/0028/0029: no network
access to a real browser or to google.com from this sandbox, so
`collectDomSnapshot.ts`'s actual browser-side behavior (`el.outerHTML`,
`getComputedStyle(el).getPropertyValue("color")`, `getBoundingClientRect()`)
is verified only via the same isolation-boundary technique
`resolveComponentBoundary.test.ts`/`collectdomsnapshotselfcontained.test.ts`
already established — reconstructing the real, built function via
`new Function` in a scope with nothing but fake `document`/
`getComputedStyle`/`Node` globals, exactly what `page.evaluate` provides —
not by a live re-capture.

## Context

ADR 0028/0029 fixed the SearchInput box itself (correct fill, border,
shadow). What was still wrong, confirmed from the user's own captured
`.svg`: the search/mic/camera icons inside it rendered as invisible
empty boxes. Google (like most real sites) renders these as inline
`<svg><path>` vector graphics — and Design IR's node model
(`frame`/`group`/`text`/`shape`/`image`/`instance`) has no node type for
arbitrary vector path data. `collectDomSnapshot.ts`'s DOM walk had no
special handling for `<svg>` either: it just walked into it like any
other element, producing a `frame` node for the `<svg>` itself and
further (empty, useless) nodes for `<path>`/`<g>`/etc — none of which
carry the actual vector artwork, since path geometry isn't a computed
CSS style property.

The user's own framing of the fix (an explicit ask, not something this
ADR is guessing at): reuse the existing six node types — specifically
`image` — rather than introduce a seventh, and make the exported SVG
visually match the captured page.

## Decision: capture the whole `<svg>` as one flattened unit, as an `image` node

An inline `<svg>` icon is captured the same way an `<img>` already is —
whole, as a single asset reference — not decomposed into per-path Design
IR nodes. Concretely:

1. **`collectDomSnapshot.ts`** (browser-side walk): when `el.tagName ===
   "svg"`, `walk()` captures `el.outerHTML` into a new `svgMarkup` field
   on `RawDomSnapshot`, and does NOT recurse into the element's children
   (`children: []`) — mirroring how an `<img>` was already a leaf as far
   as the walk is concerned, just via a different signal (`isImg` vs.
   `isSvg`). Two corrections are applied to the captured markup before
   it's used anywhere else:
   - `fill="currentColor"`/`stroke="currentColor"` is resolved to this
     element's own actual computed `color` — `currentColor` only
     resolves correctly inside the page it was captured from (it
     inherits from wherever it's rendered); re-embedded standalone
     elsewhere, it would silently resolve to whatever default color
     applies THERE instead, typically black.
   - A `viewBox` is synthesized (from the element's own `width`/`height`
     attributes, or its bounding rect as a last resort) when the markup
     has none — needed for the icon to scale correctly once embedded at
     a different size (the Design IR image node's own captured bounds,
     not necessarily the original element's).
2. **`interpretDomSnapshot.ts`** (Node-side evidence interpretation):
   `svgMarkup` is base64-encoded into a `data:image/svg+xml;base64,...`
   URI and placed into `ElementEvidence.image` — the EXACT SAME shape an
   `<img>`'s `src` already populates (`{src, naturalWidth, naturalHeight,
   alt}`). `naturalWidth`/`naturalHeight` fall back to the captured
   layout box (an inline `<svg>` has no bitmap "natural" size the way an
   `<img>` does); `alt` is always `null` (no equivalent attribute).
3. **`buildDesignIR.ts`**: `mapNode`'s dispatch condition relaxed from
   `el.tag === "img" && el.image` to just `el.image` — since `.image` is
   now populated identically for both an `<img>` and an `<svg>` icon
   (step 2), there is no remaining reason to gate on the tag name a
   second time. `mapImageNode` itself needed NO changes at all — it was
   already tag-agnostic.
4. **`guessMimeType`** (also `buildDesignIR.ts`): gained a `data:` URI
   branch — parses the mime type directly out of the URI prefix
   (`data:image/svg+xml;base64,...` → `"image/svg+xml"`) rather than
   falling through its existing file-extension-based switch, which would
   find no `.` in a base64 payload and default to
   `"application/octet-stream"`.
5. **`exportDesignArtifactTool`** (`.rfd` packaging): gained a `data:`
   URI branch in its asset-embedding loop — decodes the URI directly into
   bytes (`decodeDataUri`) rather than attempting an HTTP fetch, since
   the bytes are already fully inline; a malformed one produces a
   warning ("left unembedded"), same non-fatal-degradation policy as
   every other asset failure mode this function already has.
6. **`renderSvg`/`renderHtml`** (SVG/HTML export, ADR 0027/0028): needed
   NO changes. Both already emit `<image href="...">`/`<img src="...">`
   with `asset.path` used verbatim — a `data:image/svg+xml;base64,...`
   value there is already valid, standard SVG-in-SVG /
   SVG-in-HTML embedding. This is the same "reuse existing
   abstractions" principle the whole node-model decision rests on: not
   just the Design IR schema, but the entire downstream export pipeline
   required zero new code to already handle this correctly.

### Why `image`, not a new `vector`/`path` node type

Considered and rejected, matching the user's own explicit framing: a new
node type would need schema changes propagated through validation
(`@reactfig/core`), every exporter (`.rfd`'s Figma-plugin renderer,
`renderSvg`, `renderHtml`, JSON — which needs none, being the IR itself),
merge/checkpoint logic, and the AI interpretation schema — a large
surface for a capability the existing `image` node type already covers
completely once given the right asset content. An SVG data URI is
losslessly re-renderable vector content, not a rasterized approximation —
nothing about fidelity was traded away by reusing `image` instead of
inventing a new type.

### What this does NOT do

- Does not attempt to decompose a captured icon into its constituent
  paths as separate Design IR nodes (e.g. for independent recoloring of
  sub-parts in Figma) — the icon is one opaque visual unit, same
  granularity as a PNG/JPEG `<img>` always was.
- Does not resolve CSS-class-driven coloring of SVG sub-elements (a
  `<path class="accent">` colored via an external stylesheet rule rather
  than an inline `fill` attribute or `currentColor`) — only the
  `currentColor` keyword is resolved; a real external-stylesheet color
  would already be present as a literal color in the captured
  `outerHTML` regardless (browsers serialize `outerHTML` from the DOM
  tree, not the original authored markup, so computed presentational
  attributes are NOT auto-inlined — only what was literally present as
  an attribute in markup survives). This is a known, disclosed gap, not
  silently assumed to work.
- Does not handle an `<svg>` referencing an EXTERNAL resource via
  `<use href="#external-sprite-id">` pointing outside the captured
  subtree, or `<image href="...">` inside the icon referencing a further
  external URL — both would serialize into the captured `outerHTML` as
  literal (possibly now-dangling, if the reference was relative to
  something only valid on the original page) references.

## Verification

- `collectdomsnapshotselfcontained.test.ts` gained 5 new tests, all via
  the real isolation-boundary technique: markup capture without
  recursing into `<path>` children, `currentColor` resolution, viewBox
  synthesis (both the injection and the "don't double-inject when one
  already exists" cases), and `svgMarkup: null` for a non-svg element.
- `interpretDomSnapshot.test.ts` gained 5 new tests: data-URI
  construction and round-trip (decode back to the original markup),
  natural-size fallback to the captured layout box (with rounding), null
  `alt`, and `image: null` when there's no `svgMarkup`.
- `buildDesignIR.test.ts` gained 1 new test: an svg-rooted capture maps
  to an `image` IR node, registers exactly one asset with
  `mimeType: "image/svg+xml"` and the layout-box-derived
  width/height, matching the existing `<img>` test's exact assertion
  shape for direct comparison.
- `exportDesignArtifact.test.ts` gained 2 new tests: a `data:` URI asset
  is decoded and embedded into the `.rfd` (round-tripped through a real
  `pack()`/`unpack()`, byte-for-byte content match, no "left unembedded"
  warning), and a malformed one produces a warning rather than throwing.

Full workspace: 739 tests, all packages, zero regressions (including
every pre-existing `<img>`-path test — the relaxed `mapNode` dispatch
condition, `el.image` instead of `el.tag === "img" && el.image`, is
provably non-breaking precisely because `.image` was, and remains, only
ever populated for those same two tags).
