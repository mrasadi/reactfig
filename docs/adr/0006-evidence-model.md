# ADR 0006: Evidence Model as its own pipeline stage

## Status
Accepted

## Context
It would have been simpler to have the analyzer call a model directly and
emit Design IR fragments in one step. That couples browser inspection to
IR generation and to whatever model happens to be configured, and makes it
impossible to answer "what did the analyzer actually know before the model
touched anything" — which matters both for debugging fidelity problems and
for keeping the AI layer honest about only resolving genuine ambiguity.

## Decision
Insert an explicit Evidence Model stage between inspection and AI
reasoning:

```
React/TSX → Deterministic Analyzer → Evidence Model → AI reasoning → Design IR
```

`@reactfig/analyzer` produces `ComponentEvidence` (`src/evidence/types.ts`)
and stops. It has no dependency on `@reactfig/model` or `@reactfig/core` in
Phase 3 — those are pulled in only when Phase 4 adds the reasoning step
that consumes evidence and emits IR fragments.

`ComponentEvidence` is plain, JSON-serializable data on purpose (verified
in `test/buildComponentEvidence.test.ts` via a `JSON.stringify`/`parse`
round trip) — an engineer should be able to dump it to a file and read
exactly what the AI layer saw.

## Sub-decisions made while implementing this

**Collection vs. interpretation are separate functions.**
`browser/collectDomSnapshot.ts` runs inside the page (Playwright
function-serialization) and only returns raw CSS strings —
`evidence/interpretDomSnapshot.ts` is a pure function that turns those
strings into structured `ElementEvidence`. This means the "hard to test"
surface (anything requiring a real browser) is as thin as possible, and
the actual interpretation logic (color parsing, flex/grid detection,
padding-box assembly) is fully unit-testable with plain JSON fixtures — see
`test/interpretDomSnapshot.test.ts`.

**CSS Grid evidence is captured in full even though IR v1 doesn't model it.**
`StyleEvidence.grid` and `StyleEvidence.gridChildPlacement` preserve the raw
`grid-template-columns`/`grid-template-rows`/`grid-auto-flow`/gap values and
each child's own `grid-column`/`grid-row`. `buildComponentEvidence` also
adds a `meta.limitations` entry when a capture contains Grid, so the v1
IR's absolute-position fallback (ADR 0002) is a visible, explained
decision at generation time, not a silent loss. A future IR version adding
semantic Grid support would read this evidence directly — no re-inspection
needed.

**Mixed-style text runs are similarly a preserved-but-deferred concern.**
`ComponentEvidence.meta.limitations` always includes a note that inline
mixed-style text is captured as one `ElementEvidence` per DOM element (not
split into runs). The evidence itself doesn't need a text-run field yet —
the DOM element's full text and its single computed style are captured
faithfully; run-splitting is a Design-IR-generation-time decision (ADR
0005) about how to represent what was captured, not something lost at the
evidence stage.

**No DOM-to-JSX correlation beyond the component root.**
Considered using a React DevTools global hook / fiber walk to map DOM
nodes to their originating JSX elements. Rejected for v1: fragile across
React versions, meaningfully more complex, and not required to hit the
stated goal (faithfully reconstructing rendered output) — DOM evidence
already carries everything needed to reconstruct geometry/style, and AST
evidence already carries component composition (which sub-components are
used). What's lost is a *verified* correlation between the two; documented
as a known limitation rather than solved.

## Consequences
- Phase 4 (AI reasoning) has a stable, versionable input contract to
  design against, independent of whether the browser layer or the AST
  layer changes internally.
- Evidence documents are inspectable/debuggable on their own — a
  fidelity bug report can include the `ComponentEvidence` JSON instead of
  requiring a live repro.
- The Evidence Model has its own implicit "version" (shape of
  `src/evidence/types.ts`) that isn't yet formally tracked the way
  `design-ir/v1` is (no JSON Schema, no `$schema` field). Worth revisiting
  once Phase 4 stabilizes what AI reasoning actually needs from it.
