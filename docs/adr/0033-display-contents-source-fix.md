# ADR 0033: `display: contents` elements must never become their own Design IR node

## Status

Accepted. Found by direct inspection of the actual generated HTML for
the user's real `ClaudeNavigation.rfd` after ADR 0032's flexbox fix —
the flex-container fix was correct, but children of one specific
wrapper (`u-display-contents` — a real, literal CSS class name from the
capture) were rendering at wildly wrong positions (`left:177px` inside a
48px-tall row). Traced to exact root cause below, not guessed. Verified
with new unit tests in `interpretDomSnapshot.test.ts`, including one
built directly from the real captured shape, and by re-rendering the
user's actual IR (with the fix's effect simulated by splicing the
degenerate node out directly, since the existing `.rfd` fixture predates
this fix and can't be regenerated without a live re-capture — no browser
in this sandbox, as every prior ADR here discloses). Same disclosed
limitation as always: not verified in an actual browser.

## Symptom

After ADR 0032's flexbox fix, most of `ClaudeNavigation.rfd`'s HTML
export rendered correctly (9 real `display:flex` containers), but six
real, visible buttons (`tab_btn_wrap`) were completely absent from the
visible output — positioned at `left:177px; top:408px` inside a
component whose own bounding box was only ~579×48px, i.e. rendered far
outside anything visible.

## Root cause

`tab_btn_wrap`'s DIRECT parent in the captured DOM was
`u-display-contents` — a wrapper with CSS `display: contents`. This is
meaningful, real CSS: an element with `display: contents` generates NO
box of its own; only its children participate in layout and rendering,
as if the wrapper weren't there. A browser's own `getBoundingClientRect()`
on such an element correctly reports `{x:0, y:0, width:0, height:0}` —
there IS no box to measure. `collectDomSnapshot.ts` (already fixed once
before, ADR 0028, to stop walking into genuinely non-visual tags like
`<style>`/`<script>`) had no reason to treat `display:contents`
specially — it's a perfectly ordinary, walkable DOM element in every
other respect — so it was captured as an ordinary Design IR frame node,
with that degenerate `{0,0,0,0}` bounds.

This degenerate bounds value is fine as long as nothing downstream
treats it as a meaningful reference point — and ADR 0031's Figma fix
doesn't: every child gets an EXPLICIT `layoutPositioning: "ABSOLUTE"`
and pixel-exact `x`/`y` regardless of what the parent's own Auto Layout
would otherwise compute, so the degenerate frame's own (wrong) position
is irrelevant to where its children actually render.

ADR 0032's HTML flexbox fix does NOT have that same safety net, by
design — it deliberately lets the browser's real flex algorithm
determine a flex item's position rather than pinning it. That's exactly
right for a normal flex item. But `u-display-contents` is a flex item of
`tab_menu_inner` (which IS flex) AND has its own non-flex children
(the six real buttons) needing `position:absolute` RELATIVE TO IT. The
math for that (`child.bounds - parent.bounds`, both taken from
`resolveTree.ts`'s captured/translated values) is only valid when the
parent's OWN captured bounds accurately describe where it will actually
render — true for an absolutely-positioned parent (its rendered
position literally IS its `left`/`top`, which come directly from those
bounds), but NOT true for a flex item, whose real on-screen position is
determined by the flex algorithm (padding + gap + alignment + sibling
sizes), with no necessary relationship to its own captured bounds at
all — and doubly so when those captured bounds are degenerate
`{0,0,0,0}` to begin with. Using them as a reference point for the
buttons' relative-position math produced numbers with no real meaning.

## Decision: fix it at the source, not in every exporter

`display: contents` elements are now eliminated from the capture tree
entirely, in `interpretDomSnapshot.ts` — the single Node-side function
every raw capture (live or from a finalized Interactive Capture
selection) passes through on its way to becoming `ElementEvidence`. A
child whose `computedStyle["display"] === "contents"` is skipped
outright; ITS OWN children are spliced into its parent's children array
at its position instead (`expandDisplayContentsChildren`, applied
recursively — a chain of nested `display:contents` wrappers is fully
unwound, not just one level). This exactly matches real CSS box-tree
semantics: the wrapper never generates a box, so its children are
promoted to participate in the PARENT's own layout directly, precisely
as a real browser already treats them.

Every downstream consumer — `buildDesignIR.ts`, `renderSvg`,
`renderHtml`, the Figma plugin's `renderNode.ts` — never sees this class
of element at all going forward, so nothing needed to change in any of
them. This is the same "fix it once, upstream, not per-consumer"
principle ADR 0028 already established for non-visual tags — and this
ADR's own bug is proof of why that principle matters: ADR 0031's Figma
fix happened to be robust to this specific degenerate-bounds shape (by
accident of its own unrelated design — forcing absolute positioning
everywhere), but ADR 0032's HTML fix was not, and there is no guarantee
some future exporter or consumer would be either. Removing the bad data
at its source removes the whole class of risk, not just the one
instance that happened to be reported.

### Why not just special-case degenerate `{0,0,0,0}` bounds in the exporters instead

Considered — detect a `{0,0,0,0}`-bounds frame in `resolveTree.ts` or
`html.ts` and skip creating a positioning boundary for it. Rejected: a
frame's bounds being exactly `{0,0,0,0}` is a symptom of
`display:contents` specifically, not a general, reliable signal on its
own (a real, deliberately zero-size element is conceivable, however
rare) — checking the actual CSS property that CAUSES this, at the one
place raw capture data is first interpreted, is a correct fix; pattern-
matching on the resulting numbers everywhere they might turn up is not.

## Known remaining question (not yet confirmed)

The same real capture also has a structurally IDENTICAL pattern for
`icon_wrap` (wrapping a single `Image` child) — some instances have real
bounds, others are degenerate `{0,0,0,0}`, exactly like
`u-display-contents`. This is very likely the same `display:contents`
pattern (icon-wrapping utility markup commonly uses it) and should
already be fixed by the same change — but this could NOT be confirmed
with certainty: the already-generated `ClaudeNavigation.rfd` fixture
only retains the final Design IR, not the raw `computedStyle` evidence
that would show `display: contents` directly for that specific element.
Confirming this — and confirming the fix overall — needs a fresh live
capture with this fix applied, which no environment available here can
perform. If it turns out NOT to be `display:contents` for `icon_wrap`
specifically, the actual `evidence.json` (or even just that one
element's raw computed `display` value) would immediately show why, and
should be sent back rather than guessed at further.

## Tests

- `packages/analyzer/test/interpretDomSnapshot.test.ts` gained 4 new
  tests: a `display:contents` child skipped with its children spliced in
  at the right position; a chain of nested `display:contents` wrappers
  fully unwound; an empty `display:contents` wrapper contributing
  nothing; and a direct reproduction of the real reported shape (a flex
  row containing a `display:contents` wrapper around several real,
  positioned buttons) asserting the wrapper never reaches
  `ElementEvidence` and the buttons keep their own correct bounds.
- Full pre-existing `analyzer` suite (300 tests before this ADR) re-run
  and passing unmodified.
- Full workspace: 752 tests, all 6 packages, zero regressions — notably
  including ADR 0031's own Figma regression test (which uses the
  ALREADY-GENERATED, pre-this-fix `ClaudeNavigation.rfd` fixture and so
  still exercises the degenerate-bounds case as before) continuing to
  pass unmodified, confirming that fix's own robustness independent of
  this one.
- The user's real IR, with this fix's effect simulated directly (the
  degenerate node spliced out, matching exactly what a fresh capture
  with this fix will produce), re-rendered through the real, built
  `renderHtml`: `tab_btn_wrap` now renders with no `position`/`left`/
  `top` at all (a genuine flex item of `tab_menu_inner`, `flex-shrink:0`,
  its own real `background`/`border-radius` visible) instead of the
  previous `left:177px` garbage value.
