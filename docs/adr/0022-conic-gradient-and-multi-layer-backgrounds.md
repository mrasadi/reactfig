# ADR 0022: conic-gradient support and multi-layer backgrounds

## Status

Accepted. Part of the v2 hardening pass (see ADR-0021 for the rest —
this ADR covers the two items from that pass that needed a genuine
schema/mapping change rather than a smaller fix).

## Decision 1: `conicGradient` Fill

Same pattern as ADR-0021's `radialGradient` addition: new additive `Fill`
variant (`types.ts` + JSON schema), `parseConicGradient` in
`parseGradient.ts` reusing the shared `parseColorStops`, renderer support
in `style.ts` (`GRADIENT_ANGULAR` + a combined rotate-and-translate
`gradientTransform`, which `radialGradient`'s own transform is the
zero-rotation special case of). Same "approximate, not pixel-verified"
posture as every other gradient mapping here: only `from <angle>` (any of
`deg`/`turn`/`rad`/`grad`, normalized to degrees) and `at X% Y%` are
modeled; `repeating-conic-gradient()` and an explicit per-stop angle
(rather than percentage) aren't.

## Decision 2: multi-layer `background-image`, and a fill-order bug found while fixing it

Previously only the first comma-separated `background-image` layer was
ever read at all (ADR-0008's own catalogued gap). `resolveBackgroundFills`
now resolves every layer independently (gradient of any kind, or a plain
`url(...)`) and stacks them in the correct order.

That "correct order" is the actual reason this needed real attention
rather than a one-line loop: CSS stacks `background-image` layers with
the FIRST-listed one on TOP, and `background-color` always at the true
bottom, below every image layer. Figma's `fills` array paints in the
opposite sense — each later entry paints OVER the ones before it. Getting
this backwards doesn't just misorder multiple layers; it also affects the
*existing* single-image-plus-color case, and checking it exposed that the
existing code already had it backwards: fills were pushed
image-or-gradient-first, then color — meaning `background-color` was
rendering ON TOP of, not under, the image/gradient, for every component
that had both, regardless of how many image layers existed. ADR-0008 had
already flagged this exact risk ("which hasn't been independently
verified") without resolving it. Fixed as part of this change, not as a
separate one — building multi-layer support on top of an unverified,
backwards single-layer convention would have just propagated the bug
further instead of fixing it.

`resolveBackgroundFills` returns image/gradient layers bottom-to-top
(last-listed CSS layer first); the caller (`mapFrameNode`) `unshift`s
background-color before them, since color is always the true bottom
regardless of how many image layers exist.

## Consequences

- Both existing gradient/background-color coexistence tests had their
  expected fill order corrected (they were asserting the old, backwards
  behavior) — not weakened, corrected: same assertion strength, right
  answer.
- No schema break: `conicGradient` is additive, and the fill-order fix
  doesn't change what fills exist, only the array position they're
  returned in — which nothing outside the renderer's own paint order
  should have depended on the old (wrong) order for.
- Test suite grew from 593 to 609 across this ADR's fixes.

## What's still not modeled (see ADR-0021's own list for the rest)

`repeating-*-gradient()` variants (no "repeat" concept in the schema, any
gradient kind), explicit conic-gradient stop angles, and — unrelated to
gradients — anything not resolvable to a gradient or a plain `url()` in a
background layer (e.g. `image-set()`) is dropped from that layer rather
than guessed at.
