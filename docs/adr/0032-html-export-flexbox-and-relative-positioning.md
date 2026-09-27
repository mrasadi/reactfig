# ADR 0032: HTML export — real CSS flexbox, and correctly parent-relative absolute positioning

## Status

Accepted. Found via user report with a concrete symptom (a screenshot
of DevTools showing a nested `<img>` several `position:absolute` levels
deep, visibly drifted from its intended spot) and the user's own
diagnosis of a working-but-unsatisfying fix (`position:fixed` instead
of `position:absolute`). Verified with new unit tests reproducing the
exact bug shape (multi-level nested absolute positioning; a non-flex
subtree nested inside a flex one) and by re-rendering the user's own
real `ClaudeNavigation.rfd` (already on hand from ADR 0031) through the
fixed exporter — genuinely produces real `display:flex` containers now
(9 of them in that file), not just differently-computed absolute
offsets. As with every other ADR touching generated output that isn't
directly executed in this sandbox, this was NOT verified by opening the
rendered HTML in an actual browser — no browser is reachable here (see
every prior ADR's own disclosure of this same limitation).

## Symptom (as reported)

A captured `<img>` (and other deeply-nested elements) rendered visibly
displaced from their correct position in the exported HTML — small but
real drift, worsening with nesting depth. DevTools showed the element
several levels deep inside a chain of `<div>`s, each with
`position:absolute; left:...; top:...`. The user traced it to
`html.ts`'s `baseStyle()` and found that changing `position:absolute` to
`position:fixed` fixed the visual symptom — but correctly suspected this
wasn't the right fix, and asked for a systematic one using real
flexbox/`align-items`/`justify-content`.

## Root cause

`resolveTree.ts`'s `resolveRoot` (shared by both the SVG and HTML
exporters) expresses every node's `bounds` relative to a SINGLE global
anchor — the overall export root — not relative to each node's own
immediate parent. This is exactly right for SVG: plain SVG shape
coordinates (`x`/`y` on a `<rect>`, `<text>`, etc., with no `transform`
attribute involved) are already all in the same flat coordinate space,
so using one global offset for every node, at any nesting depth, is
correct and was never the bug.

CSS is different: `position:absolute`'s `left`/`top` are relative to the
nearest ANCESTOR that is itself positioned (anything other than
`position:static`). `html.ts`'s `baseStyle()` gave every single node
`position:absolute` using the SAME global bounds SVG uses — so at
nesting depth N, a node's `left`/`top` were computed as
"distance-from-global-root", but the BROWSER interpreted them as
"distance from my immediate parent" (itself already offset from the
global root by ITS OWN global `left`/`top`) — compounding the same
global offset once per positioned ancestor in the chain. This is the
CSS-side counterpart to ADR 0031's Figma bug (`relativePosition`'s math
was correct there too; the bug was Figma Auto Layout silently
discarding it) — different mechanism, same shape of root cause: a
correct GLOBAL coordinate being fed into an API that expects a
PARENT-RELATIVE one.

### Why `position:fixed` "fixed" it, and why that's not the real fix

`position:fixed` ignores ALL ancestors and always measures `left`/`top`
from the viewport — which happens to coincide with the global convention
`resolveTree.ts` already uses, at any nesting depth, with no compounding
possible (there's nothing to compound against). It is coincidentally
correct for THIS use case (a document meant to fill the viewport, viewed
un-scrolled, not embedded in anything else), but breaks the moment the
exported HTML is embedded inside another page/iframe, scrolled, or
placed inside any container with its own positioning — `position:fixed`
does not respect any of that, by design. It also isn't what the user
actually asked for: real, editable, semantically-structured HTML that
uses layout the way the original page did, not every element pinned by
raw coordinates.

## Decision: real CSS flexbox for captured flex layouts; correctly parent-relative absolute positioning for everything else

Mirrors ADR 0031's structure exactly, translated to CSS instead of
Figma's node API:

1. **A frame whose captured `layout.mode !== "none"` becomes a real CSS
   flex container** (`flexContainerCss`): `display:flex`,
   `flex-direction` (`row`/`column` from `horizontal`/`vertical`),
   `justify-content` (from `primaryAxisAlign`), `align-items` (from
   `counterAxisAlign` — CSS has a native `stretch` keyword here, so
   unlike ADR 0031's Figma fix, no per-child workaround property is
   needed at all), `gap`, `padding`, and `flex-wrap` when captured. The
   container keeps its own literal captured `width`/`height` (never
   "hug contents" — same "measured, not a hint" principle ADR 0031 also
   applies), which is why a NEW global `*{box-sizing:border-box;}` was
   added: without it, an explicit `padding` would grow the box beyond
   its captured size instead of being subtracted from it.
2. **Children of a flex container get NO `position`/`left`/`top` at
   all** (`positionCss`) — the browser's own flex algorithm places them,
   the same "let the real engine own this axis" choice ADR 0031 made for
   Figma's Auto Layout. `flex-shrink:0` keeps each child at its own
   captured size (never letting flexbox shrink it below that — Design IR
   bounds are a literal measurement, not a suggestion).
3. **Everything else still uses `position:absolute`** — but now computed
   relative to `positioningRef`, the node's IMMEDIATE parent's own
   (global) bounds, not the raw global bounds directly. `renderNode` now
   threads `positioningRef`/`isFlexItem` down through the recursion,
   updated at each frame/group boundary to that frame/group's own bounds
   — the exact `child.bounds - parent.bounds` computation
   `geometry.ts`'s `relativePosition` already does on the Figma side,
   just inlined here since HTML doesn't need a shared helper function
   for one subtraction.
4. **A node with non-flex children needs `position:relative`** purely
   to serve as the correct containing block for THOSE children's
   `position:absolute` — but only when it isn't ALREADY
   `position:absolute` itself (a node has exactly one `position` value;
   `absolute` already establishes a valid containing block for its own
   descendants, so `anchorForChildrenCss` only adds `relative` for a
   FLEX ITEM that itself has non-flex children needing an anchor).

### Instances stay transparent — no wrapper `<div>`

`resolveTree.ts`'s instance expansion always produces EXACTLY one
resolved child (the expanded root) — confirmed by re-reading that file
as part of this fix, not assumed. Because of that, splicing an
instance's one child directly into its parent's output, inheriting
whatever `positioningRef`/`isFlexItem` the instance itself would have
received, is exactly equivalent to the instance boundary not existing —
correct with no wrapper element needed, and with no risk of "multiple
top-level children suddenly appearing in a flex flow" (a real concern
that was considered and ruled out specifically because there is always
exactly one child).

### Rejected: keeping absolute positioning everywhere, just computing it correctly

Considered — the compounding bug could have been fixed by ONLY doing
item 3 above (correct parent-relative math) without items 1/2 (real
flexbox) at all, which would have been a smaller change. Rejected
because it wouldn't have addressed what was actually asked: "a real
HTML DOM ordered component as similar as possible to the actual
captured component," using flexbox specifically, so the exported markup
reflects genuine layout intent (and remains usable if someone wants to
edit dimensions/content and have the layout respond) rather than a
pile of independently-positioned boxes that merely happen to render
correctly at one specific size.

## Tests

- `packages/artifact/test/export/exporters.test.ts` gained 5 new tests
  under "renderHtml — real flexbox reconstruction and correct nested
  positioning": a captured flex frame produces real `display:flex` +
  mapped alignment/gap/padding, with children carrying no
  `position:absolute` at all; `vertical`/`stretch` mapping; a
  `layout:"none"` subtree nested INSIDE a flex frame (the general form
  of the reported bug — a non-flex island a few levels deep) asserts the
  EXACT correct parent-relative pixel offsets, and explicitly asserts
  the PRE-FIX (wrong) values are absent; three levels of plain nesting
  with zero flex anywhere, proving zero cumulative drift at any depth;
  and that `box-sizing:border-box` is present globally.
- All 18 pre-existing exporter tests re-run and passing unmodified (none
  of them asserted exact coordinate values, so none needed updating —
  but their continued passing confirms nothing about SVG export,
  JSON export, or general HTML structure/escaping regressed).
- Full workspace: 748 tests, all 6 packages, zero regressions.
- The user's own real `ClaudeNavigation.rfd` (already committed as a
  fixture for ADR 0031) re-rendered through the fixed exporter produces
  9 real `display:flex` containers, confirmed by direct inspection of
  the output, not just a byte-length check.
