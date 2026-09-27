# @reactfig/analyzer

Turns a running React app + its TSX source into an **Evidence Model** —
deterministic, inspectable evidence — and, since Phase 4, orchestrates a
`ModelProvider` (from `@reactfig/model`) to turn that evidence into a
validated `design-ir/v1` document. See `docs/architecture.md` for the full
pipeline, `docs/analyzer/evidence-model.md` for the `ComponentEvidence`
contract, and `docs/analyzer/ai-orchestration.md` for the AI orchestration
layer (`src/ai/`) — tool-calling, evidence selection, structured output,
and the validation/repair loop.

```
React/TSX
   ↓
Deterministic Analyzer   (this package)
   ↓
Evidence Model           (this package's output — src/evidence/types.ts)
   ↓
AI reasoning              (Phase 4, not yet implemented)
   ↓
Design IR                 (@reactfig/core)
```

## Two independent evidence sources

**AST layer** (`src/ast/inspectComponentSource.ts`, via `ts-morph`): reads
a `.tsx` file and extracts the component's name, its resolved prop types
(via the TS type checker, not syntax guessing), which props look like
variant axes (string-literal unions), default values from destructuring,
the JSX tree as written, and which capitalized JSX tags resolve to an
imported sub-component. This is corroborating structural evidence — it
never claims to know what actually rendered.

**Browser layer** (`src/browser/`): a small in-page collector
(`collectDomSnapshot.ts`) meant to run via Playwright's
`page.evaluate(collectDomSnapshot, selector)` against a real, running app.
It walks the DOM subtree at a selector and returns a `RawDomSnapshot` —
tag, direct text, bounding rect, and a fixed allow-list of computed-style
properties, as plain serializable data. `captureComponent.ts` is the
Playwright orchestration around it (navigate/locate, evaluate, screenshot).

These two are then combined by `buildComponentEvidence()` into one
`ComponentEvidence` document — no inference, just merging plus disclosing
known, intentional gaps (see "Known limitations" below).

## Why evidence is interpreted separately from collection

`collectDomSnapshot.ts` produces a `RawDomSnapshot` (raw CSS strings, e.g.
`"background-color": "rgb(28, 97, 250)"`). `evidence/interpretDomSnapshot.ts`
turns that into structured `ElementEvidence` (parsed colors, padding boxes,
flex/grid properties, typography). The split matters because
`collectDomSnapshot` **must** run inside a browser (it's executed via
Playwright's function-serialization) and can't be unit tested without one,
while `interpretDomSnapshot` is a pure function of plain data and can be
tested exhaustively without a browser at all. See "How this was verified"
below for what that split enabled.

## CSS Grid: preserved, not modeled in the IR

Per `docs/adr/0002-design-ir-scope.md`, `design-ir/v1` has no semantic Grid
node — Grid regions fall back to absolute positioning. This package does
**not** discard the fact that the source used Grid: `StyleEvidence.grid`
(raw `grid-template-columns`/`grid-template-rows`/`grid-auto-flow`/gaps) and
`StyleEvidence.gridChildPlacement` (each child's own `grid-column`/`grid-row`)
are captured in full. `buildComponentEvidence` also adds an explicit
`meta.limitations` entry when a capture contains Grid, so the gap is visible
rather than silently absorbed. A future IR version can add semantic Grid
support by reading this evidence — the inspection layer would not need to
change.

## Known limitations (intentional, disclosed in every `ComponentEvidence.meta.limitations`)

- **No DOM-to-JSX node mapping beyond the component root.** The analyzer
  does not attempt to correlate individual DOM elements with the JSX nodes
  that produced them (e.g. via a React DevTools hook / fiber walk). That's
  fragile across React versions and out of scope for a small v1 — AST
  evidence and DOM evidence are two independent, corroborating sources, not
  a verified 1:1 mapping. AI reasoning (Phase 4) is expected to use
  structural/order heuristics where it needs that correlation.
- **Mixed inline text styling** (one bold word in a sentence) is captured
  as a single `ElementEvidence` with one `typography` — splitting it into
  multiple Design IR `Text` nodes (per ADR 0005) is a later-phase concern,
  not this package's.
- **Static prop-type resolution** covers the common patterns (typed,
  possibly destructured, first parameter) and does not resolve
  `React.FC<Props>` generic typing or props assembled via spreads/hooks —
  see the comment above `findComponent` in `inspectComponentSource.ts`.
  When resolution fails, DOM/computed-style evidence is unaffected and
  remains the authority for what actually rendered.

## How this was verified

This repository's sandboxed dev environment has no network access to
download a Playwright browser binary, so `collectDomSnapshot` +
`captureComponent` (the browser-orchestration half) are real, type-checked
code that has **not** been exercised against a live browser here. Everything
downstream of a raw snapshot has been verified for real:

- `test/inspectComponentSource.test.ts` — 13 tests against real `.tsx`
  fixtures (`test/fixtures/react/`: `Button`, `Card`, `Avatar`, `Badge`,
  `SessionCard`), covering variant-axis extraction, defaults, event-handler
  detection, JSX outline, and nested-component import resolution.
- `test/interpretDomSnapshot.test.ts` — 18 tests against hand-crafted
  `RawDomSnapshot` fixtures (`test/fixtures/raw-snapshots/`) representing
  exactly what a real browser capture would produce: flex layout,
  typography, box-shadow/border, a CSS Grid region with per-child
  placement, an image asset with natural dimensions, and the same element
  at two viewports (desktop grid vs. mobile flex-column) for the
  responsive-evidence case.
- `test/buildComponentEvidence.test.ts` — 7 tests combining real AST
  evidence with multiple render captures (a two-variant Button, a nested
  `SessionCard`), confirming variant/prop correlation, the disclosed Grid
  limitation, and that the full evidence document round-trips through
  `JSON.stringify`/`parse` for inspectability.

**38/38 tests pass**; `tsc --noEmit` is clean across the whole package,
including the Playwright-typed browser files. The next real integration
step — running `captureRenderedComponent` against the sample React app from
`examples/sample-react-app` in a real browser — is planned for Phase 7
(end-to-end example), once a CI environment with Playwright browsers
available can run it.

## Architecture review: is Playwright + AST still right?

Revisited per your request before implementation:

- **Playwright**: confirmed. CDP-based computed-style/bounding-box access,
  the official `locator.screenshot()` API, and stable selectors are exactly
  what deterministic evidence collection needs; nothing in this phase
  surfaced a reason to reconsider (see ADR 0002/architecture.md — Chromium
  only, no cross-browser need).
- **TSX/AST**: confirmed, refined to use `ts-morph`'s semantic `Type` API
  (`getType()`, `.isUnion()`, `.isStringLiteral()`) rather than syntactic
  type-node walking — this resolves type aliases and indirection (e.g. a
  prop typed via a separately-declared `type ButtonVariant = ...`) for
  free, which syntax-only parsing would have missed.
