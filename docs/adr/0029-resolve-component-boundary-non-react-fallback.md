# ADR 0029: `resolveComponentBoundary`'s parent/child adjustment had no non-React fallback

## Status

Accepted. Diagnosed from a full checkpoint directory (`.reactfig/`) the
user supplied after re-running Interactive Capture against
`https://www.google.com` with ADR 0028's `MAX_TOOL_ITERATIONS` fix
applied — `evidence.json`, `interpretation.json`, `design-ir.json`,
`manifest.json`, and the raw selection's `evidence.json`/`screenshot.png`
all together, not just the final export. That made this a genuine
diagnosis rather than another guess: the previous two rounds
(ADR 0028) worked from the exported `.svg`/`.rfd` alone and had to infer
backward from symptoms; this time the actual captured computed-style
evidence and the actual DOM selector were both available directly.

Same verification caveat as ADR 0027/0028: no network access to a real
browser or to google.com from this sandbox, so the fix below is verified
by a new, purpose-built fake-DOM test (same isolation technique the rest
of `resolveComponentBoundary.test.ts` already uses — reconstructing the
function via `new Function` in a scope with nothing but a fake
`document`, exactly what `page.evaluate` provides), not by a live
re-capture.

## What the checkpoint actually showed

`interpretation.json` this time had `"notes": ""` — no tool-budget
message — confirming ADR 0028's fix worked: the model was no longer cut
off. It still produced `"nodeAnnotations": []`, and the reason is not an
AI-interpretation problem at all:

- The captured node's own `evidence.json` shows `backgroundColor: rgba(0,
  0, 0, 0)`, `boxShadow: null`, and only a fully-transparent `border` —
  **this specific DOM element genuinely has no visible styling of its
  own.** There was nothing for the model to annotate; it correctly
  reported what was there.
- The selection's own `screenshot.png` DOES show Google's bordered search
  "pill" — because the screenshot is a pixel-rect crop, and this
  element's bounding box (`{x:429, y:377, width:582, height:50}`)
  happens to exactly coincide with an ANCESTOR element that owns the
  actual visible border. The crop shows the ancestor's paint; the
  per-node evidence correctly describes only this node's own style.
- The collection manifest's `selections[0].componentPath` is `null` and
  the raw evidence's `dom.componentPath`/`isComponentRoot` are `null`/
  `false` — confirming there is no React fiber tree anywhere on this
  page at all (expected for google.com; this is exactly the case
  source-less generation, ADR 0027, exists for).

So: the wrong DOM node got selected in the first place, not styled
incorrectly or under-annotated once selected.

## Root cause

`packages/analyzer/src/browser/resolveComponentBoundary.ts` powers the
overlay's initial click (`direction: "root"`) and its "↑ Parent"/
"↓ Child" adjustment buttons. All of it is driven by
`getComponentPath`, which reads React's fiber internals
(`__reactFiber$...`) — there is no fallback for a page (or a subtree)
with no fiber tree at all:

- `direction: "root"` (the initial click): `walkUpToOwnerRoot` checks
  `ownOwner === null` and returns the clicked element completely
  unchanged if so. Reasonable as an initial default — see "What this
  ADR does NOT change" below.
- `direction: "parent"` (the adjustment button, this ADR's actual fix):
  walked ancestors looking for `owner !== null && owner !== startOwner`.
  On a fiber-free page `owner` is `null` at every single ancestor, so
  that condition is NEVER true — the loop runs all the way to `body`
  and falls through to the documented "degrade gracefully to
  `document.body`" case. On a real page, "parent" doesn't nudge the
  selection up one level at all; it jumps straight to the entire page.
  For adjusting from an unstyled inner div to its immediately-enclosing
  styled ancestor (exactly this bug's scenario), that's useless.
- `direction: "child"`: symmetric problem — `findNestedRoot` also
  requires `owner !== null`, so on a fiber-free subtree it always
  returns `null` and the button is a silent no-op.

## Decision

Added `hasOwnerInfoInChain(el)`: true if `el` or ANY of its ancestors up
to (not including) `body` has fiber-derived owner info at all. Used to
choose, per call, between the EXISTING owner-walk logic (completely
unchanged, still what runs for any React app, and for a React "island"
inside an otherwise plain page — see the added mixed-page test) and a
new plain-DOM fallback:

- `direction: "parent"`, no owner info anywhere in the chain: return
  `start.parentElement` — exactly one DOM level up, the same increment a
  developer would expect from a plain DevTools element picker on a page
  with no component model at all. Still degrades to `document.body` at
  the actual top of the tree (there's nothing further up to step to),
  but only after that many real, individually-selectable one-level
  steps — not immediately.
- `direction: "child"`, no owner info anywhere in the chain: return
  `start.children[0]` (or `start` itself, unchanged, if it has no
  element children) — symmetric with `parent`.
- `direction: "root"` is untouched — see below.

### Why `direction: "root"` was left alone

Its current behavior (stay exactly at the clicked element when there's
no owner info) is already the correct default for an initial click on a
plain page: there is no principled "component root" to infer without
some ownership model, so the literal DOM node the developer put their
cursor on is as good a starting guess as any, and — with this ADR's
fix — genuinely adjustable afterward via "parent"/"child" rather than
stuck. Changing `"root"` itself to walk upward by some heuristic
(largest ancestor with identical bounding box? nearest ancestor with a
non-transparent background?) was considered and rejected as guessing at
developer intent the click itself doesn't disambiguate — better to keep
the initial selection literal and predictable, and make the adjustment
controls actually work, than to have the tool silently second-guess
which ancestor the developer "really" meant.

## What this fixes, concretely

For this exact bug: clicking the inner div, then clicking "↑ Parent"
once, now moves the selection to its immediate parent — the actual
bordered/shadowed container — instead of jumping to `<body>`. The
developer (or an agent driving the overlay) can step up one level at a
time until the visually-styled ancestor is reached, the same way they'd
work in a real DevTools inspector.

## What this does NOT fix

This is a selection-precision fix, not an automatic one — re-running
Interactive Capture on google.com still requires clicking "↑ Parent" the
right number of times (or clicking more precisely in the first place) to
land on the actually-styled ancestor; nothing here guesses that
automatically. Nor does it change anything about React-app capture,
which never hit this path (`hasOwnerInfoInChain` is true at the very
first check whenever there's any fiber info at all, so the existing,
well-tested owner-walk logic runs completely unchanged).

## Verification

`packages/analyzer/test/browser/resolveComponentBoundary.test.ts` gained
5 new tests: one-level `parent` step with no owner info, degrading to
`document.body` only from the actual outermost element, one-level
`child` step, a no-children `child` no-op, and a mixed-page case (a
React "island" reachable through an otherwise plain-DOM ancestor chain)
confirming the existing owner-walk still applies whenever ANY ownership
info exists in the chain, not just at the exact starting node. All 9
pre-existing tests in the same file re-run and passing unmodified. Full
workspace: 726 tests, all packages, zero regressions.
