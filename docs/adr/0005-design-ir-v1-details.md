# ADR 0005: Design IR v1 — node model, and decisions found while writing it

## Status
Accepted

## Context
ADR 0002 set the *scope* of v1 (which node kinds, flexbox-only layout).
Writing the actual types and JSON Schema surfaced several concrete
decisions that weren't fully specified in the original brief. Recording
them here so they're not silently re-litigated later, and flagging two
places where the brief's assumptions needed correcting.

## Decisions

**1. Renderer-neutral vocabulary, Figma is one consumer.**
Node kinds are `Frame | Group | Text | Shape | Image | Instance`, and
components are `ComponentDef | ComponentSet` with `ComponentVariant`
entries — no Figma API types (`SceneNode`, `PAINT`, `BooleanOperationNode`,
etc.) appear anywhere in `packages/core`. `packages/figma-plugin`'s renderer
is the only place Figma-specific types exist, and it consumes this IR the
same way a hypothetical SVG or HTML renderer would.

**2. Fills and effects are arrays, not single values, from day one.**
Real CSS routinely stacks multiple backgrounds and multiple box-shadows.
Modeling `fills`/`effects` as ordered arrays (matching CSS/Figma layer
order — first entry lowest) costs nothing now and avoids a breaking IR
change later when the analyzer inevitably encounters a two-layer gradient
button.

**3. `bounds` is always present, `layout` is the semantic authority when set.**
Every node carries a `bounds` (last-known rendered geometry in the parent's
coordinate space) *in addition to* an optional `layout`. For a renderer that
implements auto-layout (Figma, or a future Yoga-based HTML renderer),
`layout` drives reconstruction and `bounds` is just useful debugging/fallback
data. For a renderer that doesn't (a plain SVG snapshot renderer, for
example), `bounds` alone is enough to place every node correctly. This is
also how the CSS Grid fallback works: a `Frame` with `layout: {mode: "none"}`
and children placed via `bounds` — see ADR 0002.

**4. Color is `{r,g,b,a}` as 0–1 floats.**
This looks Figma-specific but isn't a lock-in: it's a trivial, lossless
conversion to/from CSS `rgba()` or hex, and it's the format the primary
renderer needs anyway. An SVG/HTML renderer converts it in one line. Chose
this over storing raw CSS color strings because "what CSS color syntax was
this originally" (hex vs. `rgb()` vs. named color) is presentation detail
the IR shouldn't need to round-trip.

**5. Text nodes are single-style in v1 — mixed inline styling is out of scope.**
A `<p>` with a bold word in the middle requires per-character-range style
runs to reconstruct faithfully. That's real complexity (Figma's own
`setRangeFontName`-style API reflects this) and the brief's "be
conservative" instruction argues for deferring it. **Correction to the
implicit assumption in the brief:** a component with genuinely mixed inline
text styling should be captured by the analyzer as multiple sibling `Text`
nodes positioned to read as one line, not as a single `Text` node with an
unsupported rich-style field. This is a real fidelity limitation for that
specific pattern (rare in component libraries, common in long-form content)
and should be documented as a known gap, not silently patched over.

**6. `ComponentSet`/`ComponentVariant` model React variant props directly.**
A `ComponentSet` declares `variantProperties` (the axes — e.g. `variant`,
`size`) once; each `ComponentVariant` supplies one `root` tree and one value
per axis. This maps directly onto a React component's discriminated prop
union (e.g. `variant: 'primary' | 'secondary'`) and onto Figma's
`combineAsVariants`, without requiring the IR to know Figma's API shape —
the renderer does that translation.

**7. Constraints and design tokens are intentionally thin/deferred.**
Per ADR 0002, full resizing `Constraint`s are deferred to v1.1 — sizing
`mode: fixed|hug|fill` on `Layout`/`AxisSize` covers most real
reconstruction cases already. `TokenRef` exists as a minimal escape hatch
(`{token: "color.brand.primary"}` usable anywhere a `Color` is expected) so
the analyzer *can* record a detected token reference without the IR needing
a full token-resolution system yet — renderers are free to ignore it and
fall back to nothing, since v1 doesn't guarantee a resolved literal is also
present. This should be revisited once real components with a token system
are run through the pipeline.

## Corrections to the original brief

- The brief's Figma-plugin-facing examples (`Component`, `Variant`,
  `Instance`) are preserved as IR concepts, but the brief did not specify
  *how* a variant family is grouped. Modeling it as `ComponentSet { variants:
  ComponentVariant[] }` (rather than, say, flat `ComponentDef`s with a
  `variantOf` back-reference) was chosen because it matches how the analyzer
  will actually discover variants — from one React component's prop union,
  all at once — rather than requiring a second pass to group loose
  definitions.
- Rich/mixed-style inline text (see decision 5) was not called out as a
  limitation in the brief and needs to be, since it's a real fidelity gap
  a reviewer comparing React-vs-Figma output will notice.

## Consequences
- `@reactfig/core` has zero dependency on Figma's type definitions —
  verified by the package having no `@figma/plugin-typings` dependency.
- The schema (`design-ir.v1.schema.json`) and the TypeScript types
  (`types.ts`) are hand-kept in sync rather than generated from one
  source. For a project this size that's the pragmatic choice, but it's a
  known maintenance cost — worth revisiting (e.g. via a `zod`/`typebox`
  single-source schema+types generator) if the IR grows materially past v1.
