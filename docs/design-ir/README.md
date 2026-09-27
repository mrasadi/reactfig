# Design IR — `design-ir/v1`

The Design IR is ReactFig's own contract for describing a design: it
represents **semantics and intent**, not any particular renderer's
implementation. Figma is one renderer (`packages/figma-plugin`); the same
document is meant to remain useful for a future SVG or HTML renderer.

Source of truth: `packages/core/src/schema/design-ir.v1.schema.json` (JSON
Schema, draft 2020-12) and `packages/core/src/types.ts` (matching TS types,
hand-kept in sync — see ADR 0005 for why). A worked example is at
`docs/design-ir/example.button.json`.

## Shape

```
DesignDocument
├─ pages: Page[]
│   └─ children: Node[]        (Frame | Group | Text | Shape | Image | Instance)
├─ components: (ComponentDef | ComponentSet)[]
│   ├─ ComponentDef            no variant axes — root: Node
│   └─ ComponentSet            variantProperties + variants: ComponentVariant[]
├─ assets: AssetRef[]          registry only — bytes live in the .rfd artifact
└─ meta                        generator, generatedAt, sourceProject
```

## Node kinds (v1)

| Kind | Notes |
|---|---|
| `Frame` | Container. Optional `layout` (auto-layout), `fills[]`, `strokes[]`, `cornerRadius`, `effects[]`. |
| `Group` | Container with no visual/layout properties of its own — pure grouping. |
| `Text` | `characters` + single `typography` + `fills[]`. See "Known limitations" below. |
| `Shape` | `rectangle` \| `ellipse`, with fills/strokes/cornerRadius/effects. |
| `Image` | References an `AssetRef` by id. |
| `Instance` | A placed reference to a `ComponentDef` or a specific `ComponentVariant`, with optional `propertyOverrides`. |

Every node has `bounds` (always present) and an optional `layout`. `bounds`
is the last-known rendered geometry in the parent's coordinate space and is
always enough to place the node correctly; `layout`, when present, is the
semantic authority for renderers that implement auto-layout (see ADR 0005,
decision 3).

## Layout model

Flexbox-equivalent auto-layout only — `mode: none | horizontal | vertical`,
`gap`, `padding`, `primaryAxisAlign`, `counterAxisAlign`, `wrap`. This is a
deliberate v1 scope decision (ADR 0002): it's a direct, high-fidelity
mapping to Figma's own auto-layout primitive and to CSS flexbox, which
covers the large majority of real component layouts.

**CSS Grid is not modeled directly.** A grid-laid-out region is captured as
a `Frame` with `layout: {mode: "none"}` and children placed via their
individual `bounds` (computed from actual bounding boxes at capture time).
This reconstructs the visual result faithfully but produces a frame that
won't reflow if content changes — call this out to the user on import
(`validate_design_ir` / the plugin's import warnings) rather than silently
approximating it as auto-layout.

## Components and variants

```
ComponentSet "Button"
  variantProperties: [variant: [primary, secondary], size: [medium, large]]
  variants:
    - { propertyValues: {variant: primary, size: large}, root: <Frame ...> }
    - { propertyValues: {variant: secondary, size: medium}, root: <Frame ...> }
Instance
  componentRef: { kind: "variant", componentSetId: "...", variantId: "..." }
```

This maps directly onto a React component whose props include a
discriminated union (`variant: 'primary' | 'secondary'`) and onto Figma's
`combineAsVariants` — without the IR itself knowing anything about Figma's
API. See ADR 0005 for why grouping is done this way rather than flat
`ComponentDef`s with back-references.

## Color, fills, effects

- Color is `{r, g, b, a}`, each `0–1`. Trivially convertible to/from CSS.
- `fills` and `effects` are **arrays**, matching CSS's own layering
  (multiple backgrounds, multiple box-shadows) — not a v1.1 addition, in
  from the start (ADR 0005, decision 2).
- `Fill` is `solid | image | linearGradient`. Radial/conic gradients, and
  more than one image scale mode edge case, are deferred.
- A `Color` (in fills/strokes) may be a literal or a `TokenRef`
  (`{token: "..."}`) as a minimal escape hatch for detected design tokens —
  see ADR 0005, decision 7. Renderers may ignore `TokenRef` in v1.

## Known limitations (intentional, documented — not bugs)

- **Mixed inline text styling is not representable on one `Text` node.** A
  sentence with one bold word is captured as multiple sibling `Text` nodes.
  This is a real fidelity gap for long-form content; component libraries
  rarely hit it. (ADR 0005, decision 5.)
- **CSS Grid regions lose reflow behavior** on import (see Layout model
  above).
- **Resizing constraints and design tokens are minimal/deferred to v1.1** —
  sizing `mode: fixed|hug|fill` covers most reconstruction needs already;
  full constraint and token systems are not in v1 (ADR 0002, ADR 0005).

## Validating a document

```ts
import { validateDesignIR, assertDesignIR } from "@reactfig/core";

const result = validateDesignIR(doc);
if (!result.valid) {
  console.error(result.errors); // [{ path, message }]
}

assertDesignIR(doc); // throws with a readable message if invalid
```

The validator is used in two independent places: by `generate_design_ir` /
`validate_design_ir` in the MCP server when assembling a document, and again
by the Figma plugin when unpacking a `.rfd` artifact — the plugin never
trusts an artifact it didn't just generate itself, even one produced by an
earlier version of this same pipeline.
