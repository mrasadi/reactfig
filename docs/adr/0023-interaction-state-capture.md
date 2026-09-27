# ADR 0023: interaction/pseudo-state capture (hover/focus/active)

## Status

Accepted, with an explicit, load-bearing caveat: the actual browser-
interaction code in this ADR has NOT been exercised against a real page.
This development environment has no network access to Playwright's
browser-binary CDN (only a fixed allowlist of package registries), so
there is no live browser here to verify hover/focus/mousedown timing,
event dispatch, or settle-time behavior against. Every other decision in
this project this session was verified by an actual test run against
real or realistic fixtures before being called done; this one specific
piece (the Playwright API calls in `applyInteractionState` and the
150ms settle wait around it) could not be, and is flagged here instead of
being quietly shipped as if it had been. Real-browser QA is needed before
trusting it in production.

## Context

Before this, no capture logic anywhere in this codebase simulated any
DOM interaction — every capture reflected a component's default rendered
state. For a real component library, hover/focus/active states are
frequently part of "the component" in the same sense any prop-driven
variant is (a button's hover background, a link's focus ring, an input's
active/pressed state) — capturing only the default state means importing
such a library into Figma silently drops half of what a designer would
expect to review.

## Decision 1: `state` is a deterministic variant axis, not an AI-confirmed one

Every existing variant axis (`tone`, `status`, `variant`, ...) is
confirmed by the model during AI interpretation — Issue.md's own
"do not make the AI guess" principle applies to *which* props are
meaningful variants, since that genuinely does need judgment. Which
interaction was performed before a given capture was taken is different:
this code commanded it and knows it with certainty, with no interpretive
step involved at all. Folding it into `interpretation.variantAxes`
would have meant asking the model to confirm something it can't get
wrong, for no benefit, and coupling this feature to however that AI step
worked — worse, not better.

So `selectVariantCaptures` (`buildDesignIR.ts`) treats `state` as a
separate, always-available axis: active whenever ANY capture in the
evidence has `RenderCapture.interactionState` set, independent of
whatever prop-driven axes the model did or didn't confirm. A capture
with no `interactionState` is treated as `state: "default"` once the
axis is active, so an ordinary default-props capture lines up correctly
next to a hover capture of the same instance. A capture that has BOTH a
confirmed prop axis and an interaction state gets both dimensions in its
`propertyValues` (e.g. `{ variant: "primary", state: "hover" }`) — the
two compose, they don't compete.

No schema change: `ComponentVariant.propertyValues` and
`VariantPropertyDef` are already a flat `Record<string, string>` /
`{name, values}` shape with no fixed set of allowed axis names — "state"
is just one more axis name flowing through architecture ADR-0019 already
built.

## Decision 2: the actual interaction is driven in `playwrightCapture.ts`, not `captureComponent.ts`

`@reactfig/analyzer`'s `captureRenderedComponent` stays browser-
interaction-free — it only records `interactionState` onto the resulting
`RenderCapture` verbatim. The actual `Locator.hover()`/`Locator.focus()`/
`Mouse.down()`+`Mouse.up()` calls live in `playwrightCapture.ts`'s new
`applyInteractionState`, called right after the selector-wait succeeds
and before `captureRenderedComponent` runs, with a 150ms best-effort
settle wait for CSS transitions in between. This keeps the
interaction-performing code where the real `Page` object already lives
(this file, via `PlaywrightSession`) rather than threading a `Page`
through a function whose whole point is to stay a plausibly-mockable,
interaction-agnostic DOM reader.

`:active` has no dedicated Playwright method — the standard technique
(hover, then press the mouse button down without releasing it) is used.
`:focus-visible` specifically depends on browser focus-origin heuristics
`Locator.focus()` doesn't control; a focus capture reflects plain
`:focus`, which is what most component styling actually keys off anyway.

Cleanup matters here in a way it wouldn't for a one-shot script: the
underlying `page` is reused across captures (`PlaywrightSession`), so a
capture that requested `hover`/`focus`/`active` returns a cleanup
function the caller runs in a `finally` block — otherwise a stuck
mousedown or lingering focus would leak into whatever capture runs next
in the same page.

## Decision 3: `interactionState` is part of a capture's identity

`PlannedCaptureRequest` (capturePlan.ts) and `VariantCaptureSpec`
(generateDesignIr.ts's public tool arg) both gained an
`interactionState?: "hover" | "focus" | "active"` field, included in
`computeCaptureId`'s hash — a hover capture and its otherwise-identical
default counterpart always get distinct checkpoint capture ids, so
resuming an interrupted multi-state capture run can't confuse the two or
skip one because it looks "already done."

## What's tested versus what isn't

Tested (fully, without needing a browser): the `state`-axis logic in
`buildDesignIR.ts` (composes correctly with prop-driven axes, treats a
missing `interactionState` as `"default"`, falls back to a plain
component when nothing uses it); capture-id determinism/distinctness
(`capturePlan.test.ts`); `applyInteractionState`'s own control flow
against a fake `Page`/`Locator` (proves it calls the right Playwright
methods, in the right order, and that cleanup does what it claims — see
`playwrightcapture.test.ts`).

NOT tested, and explicitly flagged rather than assumed: whether the real
Playwright calls actually produce the intended `:hover`/`:focus`/
`:active` CSS in a real browser; whether 150ms is enough settle time for
a real component's transitions (some design systems use longer
transitions; this is a guess, not a measurement); whether
`document.activeElement?.blur()` reliably restores pre-focus state for
every possible element type.

## Consequences

- No breaking change: `interactionState` is optional everywhere it was
  added; every existing call site that never sets it behaves exactly as
  before (verified — 5 net new tests, zero existing-test changes needed).
- A capture plan requesting an interaction-state capture pays one extra
  browser round-trip (the interaction itself) plus the settle wait, on
  top of the existing per-capture cost — worth knowing if capture-time
  budgets (docs/adr/0013) are already tight and many state combinations
  are requested at once.
- This is the first feature in this project shipped with an unverified
  component flagged this explicitly. That's a deliberate choice over the
  alternative (silently shipping it as if verified, or not shipping it at
  all) — see the Status section.
