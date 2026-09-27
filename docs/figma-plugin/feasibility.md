# Phase 6 feasibility review — Design IR → Figma Plugin API

Before writing renderer code, this reviews the actual Figma Plugin API
against every Design IR concept. Facts below were verified against
Figma's published plugin-typings/developer docs (searched during this
phase, not recalled from memory alone) — sources are cited inline where a
claim is load-bearing for a design decision. Two claims fall back to
"documented behavior, not independently re-verified against a live Figma
instance" where full confirmation wasn't possible — flagged explicitly.

## Two corrections to prior assumptions

**1. `bounds` coordinate space — Phase 2's doc comment was wrong.**
`design-ir/v1`'s `NodeBase.bounds` was documented as "in the coordinate
space of the parent," but every bounds value actually flowing through the
pipeline since Phase 3 (`getBoundingClientRect()`, viewport-relative) is
**absolute/document-space**, not parent-relative — `buildDesignIR` never
re-relativizes it. This was never a functional bug (every bounds value in
a document is consistently absolute, so nothing upstream broke), but the
renderer is the first consumer that actually needs to *place* nodes, and
placing a child using `child.x = child.bounds.x` (Figma's `x`/`y` are
parent-relative) would be wrong. **Correction applied**: the renderer
computes `relativePosition(childBounds, parentBounds)` by subtraction
before setting Figma's `x`/`y`, and Phase 2's doc comment is corrected in
`packages/core/src/types.ts` to describe the actual (absolute) coordinate
space and note that renderers must relativize.

**2. IR's `counterAxisAlign: "stretch"` has no direct Figma parent-level
equivalent.** Figma's `counterAxisAlignItems` accepts only `"MIN" |
"MAX" | "CENTER" | "BASELINE"` — there is no `"STRETCH"` value at the
parent level. Stretch-to-fill-cross-axis in Figma is a **per-child**
property (`child.layoutAlign = "STRETCH"`, requiring the parent's
corresponding sizing mode to be `"FIXED"`) — a structurally different
place to set it than every other alignment value. **Correction applied**:
`counterAxisAlign: "stretch"` maps the parent to `counterAxisAlignItems:
"MIN"` (a neutral default) and additionally sets `layoutAlign: "STRETCH"`
on every direct child, which is the actual mechanism Figma uses for this
behavior.

## Feasibility matrix

| Design IR concept | Figma representation | Exact / Approximate | Fallback / notes |
|---|---|---|---|
| `DesignDocument` | Not a single Figma object — rendered into the current page (see "Scope: single-page rendering" below) | Approximate | v1 renders everything onto `figma.currentPage` inside one container frame per import; does not create/switch Figma Pages |
| `Frame` (`layout` set) | `FrameNode` with `layoutMode` | Exact | Auto Layout when `layout.mode !== "none"`; absolute positioning otherwise (below) |
| `Frame` (`layout.mode:"none"`) | `FrameNode`, `layoutMode: "NONE"`, children positioned via `x`/`y` | Exact | Children's IR `bounds` relativized against this frame's bounds (correction #1) |
| `Group` | `figma.group(nodes, parent)` | Exact | No `createGroup()` — must group already-created children; requires non-empty `nodes` (empty `Group` falls back to an empty `Frame`, since Figma disallows empty groups) |
| `Text` | `TextNode` (`figma.createText()`) | Exact, gated on font load | `loadFontAsync` must resolve before setting `characters`/`fontName`/etc. (see Typography) |
| `Shape` (`rectangle`) | `RectangleNode` | Exact | |
| `Shape` (`ellipse`) | `EllipseNode` | Exact | |
| `Image` (PNG/JPEG/GIF asset) | `figma.createImage(bytes)` → `Image` handle → set as a fill (`{type:"IMAGE", imageHash, scaleMode}`) on a `RectangleNode` | Exact | `createImage` only accepts PNG/JPEG/GIF bytes — verified in `plugin-typings` |
| `Image` (SVG asset) | `figma.createNodeFromSvg(svgText)` → `FrameNode` (a vector group, not an image fill) | **Different representation, not approximate** | SVG produces a structurally different node type than raster images; the renderer branches on `AssetRef.mimeType` |
| `ComponentDef` (no variants) | `figma.createComponent()` (behaves like a `FrameNode`) | Exact | |
| `ComponentSet` | `figma.combineAsVariants(componentNodes, parent)` | Exact, but requires a specific build order | No `figma.createComponentSet()` exists by design (empty component sets aren't supported) — must build every `ComponentNode` first, name each `"Prop=Value, Prop2=Value2"` (Figma infers variant properties from this naming convention — verified via Figma's own component-authoring docs), then call `combineAsVariants` once |
| `ComponentVariant` | One `ComponentNode` per variant, named per the convention above | Exact | Variant identity is 100% naming-convention-driven; the renderer must not include commas/`=` inside a property value or the parse breaks — sanitized (see `naming.ts`) |
| `Instance` (resolvable — refers to a component defined in the *same* document) | `componentNode.createInstance()` | Exact | Requires the referenced component to have been rendered first — see "Rendering order" below |
| `Instance` (unresolvable — `componentRef.componentId` starts with `external:`, per ADR 0008's placeholder for nested components not yet separately analyzed) | No native equivalent available | **Fallback, not faked** | Rendered as a labeled placeholder `FrameNode` (name `"⚠ Missing component: <Name>"`, sized to the instance's bounds) with a warning surfaced to the UI — never silently substituted with unrelated content, per the brief's explicit instruction |
| `ComponentProperty` (`boolean`, `text`) | `componentNode.addComponentProperty(name, "BOOLEAN"\|"TEXT", default)` | Exact | |
| `ComponentProperty` (`instanceSwap`) | `addComponentProperty(name, "INSTANCE_SWAP", defaultComponentKey)` | **Not implemented — no default component key available** | IR's `ComponentProperty` has no field for a default swap target; skipped with a warning rather than creating a property with a fabricated default |
| `fills` (solid) | `node.fills = [{type:"SOLID", color, opacity}]` | Exact | |
| `fills` (image) | See Image above | Exact (raster) / different (SVG) | |
| `fills` (linearGradient) | `{type:"GRADIENT_LINEAR", gradientStops, gradientTransform}` | Approximate | IR stores `angleDeg`; Figma wants a transform matrix — converted via a standard angle→matrix formula, not pixel-verified against real Figma rendering in this environment |
| `strokes` | `node.strokes`, `node.strokeWeight`, `node.dashPattern` for `"dashed"` | Exact | |
| `opacity` | `node.opacity` | Exact | |
| `cornerRadius` (uniform) | `node.cornerRadius` | Exact | |
| `cornerRadius` (per-corner) | `node.topLeftRadius`/`topRightRadius`/`bottomLeftRadius`/`bottomRightRadius` | Exact | |
| `effects` (dropShadow/innerShadow) | `node.effects = [{type:"DROP_SHADOW"\|"INNER_SHADOW", color, offset, radius, spread, visible:true}]` | Exact | IR's evidence pipeline doesn't currently populate this (ADR 0007 — box-shadow stays a raw string in evidence), so real generated documents rarely exercise this path; the hand-authored `docs/design-ir/example.button.json` fixture does, and is the test case |
| `effects` (blur) | `{type:"LAYER_BLUR"\|"BACKGROUND_BLUR", radius, visible:true}` | Exact | |
| Typography: family/weight/style | `figma.loadFontAsync({family, style})` then `text.fontName = {family, style}` | Exact when the font is available to the editor | `loadFontAsync` only loads fonts already available to the Figma editor — it does not fetch from the internet (verified) |
| Typography: size/lineHeight/letterSpacing/align | `text.fontSize`, `text.lineHeight`, `text.letterSpacing`, `text.textAlignHorizontal` | Exact | |
| Typography: text wrapping | `text.textAutoResize` / `layoutSizingHorizontal` on the text node | Approximate | IR doesn't currently carry a wrap-mode signal (evidence has `whiteSpace`/`textOverflow` per ADR 0007, not yet threaded into IR); renderer defaults text nodes to `"WIDTH_AND_HEIGHT"` auto-resize sized to IR bounds, documented as an approximation |
| `layout.mode:"flex"` → Auto Layout direction/gap/padding | `layoutMode`, `itemSpacing`, `paddingTop/Right/Bottom/Left` | Exact | |
| `layout` primaryAxisAlign | `primaryAxisAlignItems: "MIN"\|"MAX"\|"CENTER"\|"SPACE_BETWEEN"` | Exact | |
| `layout` counterAxisAlign (`start`/`center`/`end`) | `counterAxisAlignItems: "MIN"\|"MAX"\|"CENTER"` | Exact | |
| `layout` counterAxisAlign (`stretch`) | Per-child `layoutAlign:"STRETCH"` | **Approximate — different mechanism** | See correction #2 above |
| `layout.wrap` | `layoutWrap: "WRAP"` | Exact | Requires Auto Layout v5 (`Update 69`+ per Figma's changelog) — assumed available on any current Figma version; not independently re-verified |
| padding / gap | `paddingTop/Right/Bottom/Left`, `itemSpacing` | Exact | |
| absolute positioning (`layout.mode:"none"`) | `x`/`y` set directly, `layoutMode:"NONE"` | Exact | See correction #1 |
| Constraints (resize behavior) | `node.constraints = {horizontal, vertical}` | **Not implemented** | `design-ir/v1` has no `Constraint` concept yet (deferred to v1.1 per ADR 0002/0005) — nothing to map; every node gets Figma's default `{horizontal:"MIN", vertical:"MIN"}` |
| Assets (embedded, per manifest) | Read from the `.rfd`'s `assets/` entries, decoded, passed to `createImage`/`createNodeFromSvg` | Exact | |
| Assets (not embedded — `manifest.assets[].embedded === false`) | No content available | **Fallback, not faked** | Rendered as a labeled placeholder rectangle with a neutral fill and the asset's original filename as the node name; warning surfaced to the UI — never silently substituted with unrelated imagery |
| Nested components (same document, `Instance` resolvable) | See `Instance` row above | Exact | |

## Sandbox-specific handling required

- **`ajv` (used by `@reactfig/core`'s validator and therefore
  `@reactfig/artifact`'s `pack`/`unpack`) performs runtime code generation
  via `new Function`.** The Figma **sandbox** (`code.ts`'s execution
  context) is understood to be significantly more restricted than a normal
  JS engine and may not support this at all — so `@reactfig/core`'s
  validator must never run there. `@reactfig/artifact`'s `unpack`/
  `checkArtifact` (which call it) therefore run exclusively in the **UI
  iframe** — a normal browser context — matching the split already
  established in ADR 0003 back in Phase 1. Whether the UI iframe's own
  CSP permits `new Function`/`eval` was **not independently verified**
  against a live Figma instance in this environment; if it turns out to
  block it, the fix is switching to `ajv`'s standalone
  precompiled-validator output (a well-supported `ajv` feature requiring a
  build-time step, not a runtime dependency on `eval`) — flagged as a
  concrete, scoped follow-up rather than solved speculatively now.
- **No Node-only dependency blocks reusing `@reactfig/artifact` directly.**
  `pack.ts`/`unpack.ts`/`validateArtifact.ts`/`inspect.ts`/`manifest.ts`
  import only `jszip`, `ajv`, `ajv-formats`, and `@reactfig/core` — no
  `node:fs`, no `node:path`. Only `scripts/inspect-cli.ts` (the Node CLI,
  not part of the package's runtime exports) touches `node:fs`. **This
  means no portable parsing layer needed to be written for this phase** —
  the plugin UI imports `unpack`/`checkArtifact`/`inspect` from
  `@reactfig/artifact` directly, bundled via esbuild for the browser, with
  zero duplicated logic. This corrects an open concern from the original
  architecture brief ("if that package cannot execute directly... do not
  duplicate... introduce the smallest portable parsing layer") —
  investigation found no blocker, so no such layer exists.
- **Binary transfer, UI → sandbox.** Figma's `figma.ui.postMessage`/
  `window.onmessage` channel is understood to support structured-clone-able
  payloads including typed arrays, but documented practical message-size
  behavior and exact typed-array handling were not independently verified
  against a live Figma instance. The renderer defensively **base64-encodes**
  asset bytes for the UI→sandbox message rather than sending raw
  `Uint8Array`s — a well-established, conservative pattern for exactly this
  transport, and avoids depending on an unverified assumption.

## Rendering order

Two-pass, deterministic, no retries:

1. **Pass 1 — components.** Walk `document.components[]` and build every
   `ComponentDef`/`ComponentSet` first, populating a `componentIndex: Map<string, ComponentNode | ComponentSetNode>` keyed by `ComponentDef.id` or
   `"<componentSetId>:<variantId>"`. Nested `Instance` nodes *within* a
   component's own root tree are resolved against this same index — since
   `ComponentDef.root`/`ComponentVariant.root` never reference a component
   defined *later* in the array in any document this pipeline currently
   produces, one top-to-bottom pass suffices (no cross-references requiring
   deferred resolution have been observed; if a future IR-generation change
   introduced forward references, this would need a two-phase build —
   documented as a known constraint, not solved speculatively).
2. **Pass 2 — pages.** Walk `document.pages[]`; every `Instance` node here
   resolves against the now-fully-populated `componentIndex` from pass 1.

## Scope: single-page rendering

Every import creates one container frame on `figma.currentPage`, placed at
a deterministic, non-overlapping cursor position (successive imports are
placed side-by-side, not randomly) — not a new Figma Page. `design-ir/v1`
documents today always contain exactly one meaningful "root" instance per
Phase 4/5's scope (ADR 0009), so multi-page fan-out isn't yet a real
requirement; revisit if/when whole-screen multi-component artifacts exist.
