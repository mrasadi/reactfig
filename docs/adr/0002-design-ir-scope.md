# ADR 0002: Design IR v1 scope

## Status
Accepted

## Context
The original node/property list for the Design IR was broad (variables,
states, constraints, effects, component sets, etc.), risking a v1 that's
hard to implement and validate end-to-end.

## Decision
`design-ir/v1` includes: `Document`, `Page`, `Frame`, `Group`, `Text`,
`Shape`, `Image`, `ComponentDef`, `ComponentSet`, `Variant`, `Instance`, with
fills/strokes/radius/effects/typography as node properties, and layout
expressed **only** as flexbox-equivalent auto-layout (direction, gap,
padding, alignment).

Deferred to `design-ir/v1.1`: variables/design-tokens as first-class
references, and multi-state capture beyond states actually observed during
inspection (e.g. hover/focus require explicit interaction during capture,
not inference).

CSS Grid layouts are represented as a `Frame` containing children with
absolute `x`/`y` positions computed from bounding boxes, rather than a fake
auto-layout mapping. This is a documented limitation, not a silent
approximation.

## Rationale
Figma's own auto-layout primitive is flex-shaped; mapping flexbox to it is a
direct, high-fidelity transform. Grid has no equivalent primitive in the
Plugin API, so pretending otherwise would produce IR that looks structured
but renders wrong. Tokens/variables are valuable but orthogonal to proving
the core pipeline (React → geometry/semantics → native Figma nodes) and can
be layered on once v1 is validated against real components.

## Consequences
- Components built with CSS Grid will import as visually-correct but
  non-auto-layout frames (won't reflow if content changes) — call this out
  in plugin import warnings.
- Design tokens/variables need a v1.1 ADR before implementation.
