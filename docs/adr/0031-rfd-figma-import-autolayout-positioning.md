# ADR 0031: RFD → Figma import — Auto Layout silently discarded child positions

## Status

Accepted. Root-caused and fixed using the reporter's own real,
end-to-end-captured `ClaudeNavigation.rfd` as the primary reproduction
case (not a synthetic fixture) — see the new
`packages/figma-plugin/test/rfdImportPositioning.test.ts`, which
recursively verifies every frame/group/text/shape/image node in that
actual file's "Tab Navigation" component against its Design IR bounds.

Same disclosed limitation as every other ADR touching the Figma plugin
(see `packages/figma-plugin/README.md`, "What's tested here, and what
isn't", Category C): this fix has NOT been verified inside a real Figma
document — no such environment is reachable from this sandbox. What IS
new here, and substantially strengthens confidence relative to prior
ADRs: this fix is corroborated directly by `@figma/plugin-typings`' own
official doc comment for `layoutPositioning`, whose example code sets
`ellipse.layoutPositioning = 'ABSOLUTE'` (and `parentFrame.clipsContent =
false`) in exactly the same order, for exactly the same reason, this fix
applies — see that package's own `plugin-api.d.ts`, found and read
directly as part of this investigation, not recalled from memory.

## Symptom (as reported)

- SVG output: visually correct.
- HTML output: approximately correct.
- RFD: valid, imports into Figma without error; all node types
  (component, instance, frame, group, text, vector, image) present;
  selecting an imported component and previewing it works.
- BUT: after import, many children render displaced from their parent's
  correct position.
- Flattening the imported component makes children snap to the correct
  position — but flattening was explicitly rejected as a fix (destroys
  editability, the actual point of an RFD import).

## Investigation

The reporter's own hint list (auto-layout, layoutPositioning,
constraints) pointed at the right area immediately, and the asymmetry
they'd already noticed — SVG/HTML correct, RFD wrong — narrowed it
further before any code was read:

- `renderSvg`/`renderHtml` (ADR 0027/0028) position EVERY node using a
  SINGLE global translation from the overall export root
  (`resolveTree.ts`'s `resolveRoot`) — immune, by construction, to
  anything going wrong with any one intermediate ancestor's own bounds
  or Figma-specific layout semantics (there are none in an SVG/HTML
  export).
- The RFD → Figma path is fundamentally different: Figma's `x`/`y` are
  PARENT-relative, so getting a deeply nested node's ON-SCREEN position
  right requires EVERY ancestor's relative offset, all the way up, to be
  correct. A single wrong link anywhere in that chain breaks everything
  nested beneath it. This structural difference — not a difference in
  correctness of the underlying Design IR — is what made the RFD path
  vulnerable to a class of bug the SVG/HTML paths simply cannot have.

Reading `packages/figma-plugin/src/code/render/geometry.ts`'s
`relativePosition` confirmed the MATH itself was already correct (`child.x
- parent.x`, both absolute/document-space, exactly matching how Figma's
own parent-relative `x`/`y` should be derived — and this file already
carries precedent for exactly this class of investigation: a previous,
already-fixed bug, documented right there in `layout.ts`, where Figma's
own Auto Layout default silently discarded an explicitly-set frame
WIDTH). That same doc comment was the strongest lead: if Auto Layout can
silently override a frame's SIZE the moment `layoutMode` is turned on,
the natural next question is whether it does the same to children's
POSITION — and grepping the entire `figma-plugin` package for
`layoutPositioning` (the Figma Plugin API's actual mechanism for
exempting a specific child from Auto Layout's position control) returned
zero matches. Cross-checked directly against the real, installed
`@figma/plugin-typings` package (not recalled from training data) — its
own doc comment for `layoutPositioning` confirmed this precisely, with
example code matching the shape of the needed fix almost verbatim.
`clipsContent` (`FrameNode.clipsContent`) was checked the same way and
found equally unset anywhere in the renderer, despite already existing
as a real field on `design-ir/v1`'s own `FrameNode` schema (`core/src/
types.ts`) and already being read by the HTML exporter (ADR 0027) — just
never by the Figma one.

## Root cause

Once a Figma frame's `layoutMode` is set to anything other than `"NONE"`
(which `applyLayout`, `layout.ts`, does for every Design IR frame whose
captured `layout.mode` is `"horizontal"` or `"vertical"` — i.e. every
captured CSS flex container), Figma's own layout engine computes and
OWNS the position of every child of that frame, using padding +
itemSpacing + alignment + append order. A plain `child.x = ...`
assignment on such a child (unless that child's own `layoutPositioning`
is explicitly `"ABSOLUTE"`) is documented, intentional Figma Plugin API
behavior — not a bug in Figma, and not a bug in `relativePosition`'s own
math, which was correct in isolation the entire time. Every `render*`
function in `renderNode.ts` set `child.x`/`child.y` directly, with no
awareness of the parent's `layoutMode` at all — so for any frame whose
captured layout used flex (extremely common on real pages — Google's own
search box, in ADR 0028, was `display:flex`; the reporter's "Tab
Navigation" component nests THREE levels of it), every one of that
frame's children had its carefully-computed, correct relative position
silently discarded the moment it was assigned.

Separately, but compounding on the same real fixture: Figma frames
clip their contents by default (unlike groups) — `FrameNode.clipsContent`
was never set anywhere in the renderer, so every frame silently used
Figma's own clip-on-create default. This matters most acutely for a
frame whose captured IR bounds are degenerate (`{x:0,y:0,width:0,
height:0}` — e.g. a `display:contents` CSS wrapper, which by definition
generates no box of its own, yet still produced a Design IR frame node)
and gets resized down to `safeSize`'s minimal 0.01×0.01 floor: with
`clipsContent` defaulting to `true`, that near-zero frame would clip
away its own real, correctly-positioned children entirely — a second,
independent way for real content to visually appear "gone" or
"misplaced" beyond what the Auto Layout issue alone explains. (Note: the
reporter's own uploaded fixture's specific degenerate-bounds children —
a `display:contents` wrapper directly containing six real, visible
`tab_btn_wrap` buttons — turned out to be the exact shape that most
severely exercises BOTH bugs at once.)

### Why flattening "fixed" it

Flattening converts a selection into vector geometry — an operation
that, by its nature, reads and reconstructs from the tree's already-
resolved final state (bypassing whichever frame(s) were controlling
that state, clipping mask included) rather than replaying Figma's own
position-and-clip-driven scene graph. It doesn't re-derive from the
DESIGN IR at all — it bakes in whatever Figma's Auto Layout engine had
already settled on internally, discarding the frames (and their clipping
and flow behavior) that were producing the wrong on-screen appearance in
the first place. This "fixed" the SYMPTOM by removing the very
mechanism (Auto Layout position ownership, frame clipping) causing it —
exactly why it isn't an acceptable fix: it also removes the editable
hierarchy the whole RFD import exists to preserve.

## Decision: `layoutPositioning: "ABSOLUTE"` + explicit `clipsContent`, nothing else

`geometry.ts` gained `placeInParent(child, bounds, parentBounds,
container)`, now the single function every `render*` function in
`renderNode.ts` (and `components.ts`'s `populateComponentRoot`) goes
through to position a node — replacing every direct `relativePosition` +
`child.x =`/`child.y =` call site. It does exactly two things, in the
order Figma's own documented example uses:

1. If `container` (the REAL, immediate Figma parent at the moment of
   positioning) has Auto Layout enabled (`"layoutMode" in container &&
   container.layoutMode !== "NONE"`), set `child.layoutPositioning =
   "ABSOLUTE"` first — opting this one child out of the flow algorithm
   entirely, while leaving `container` itself completely untouched as a
   real, still-genuinely-editable Figma Auto Layout frame (padding/gap/
   alignment controls in Figma's own UI still apply to it, and to any
   sibling that ISN'T marked absolute).
2. Then set `child.x`/`child.y` from the already-correct
   `relativePosition(bounds, parentBounds)` — now guaranteed to actually
   take effect.

A newly-created `group()` result (which has no `bounds`-driven position
of its own — Figma computes it from the union of its children) gets the
same `layoutPositioning = "ABSOLUTE"` treatment separately, for the same
reason, without an accompanying x/y assignment.

`renderFrame` (`renderNode.ts`) and `populateComponentRoot`
(`components.ts`, the top-level component-root case) both gained
`frame.clipsContent = node.clipsContent ?? false` — explicit in both
places a Figma frame gets created from a Design IR frame, defaulting to
NOT clipping (matching CSS's own default, `overflow: visible`, and the
HTML exporter's existing identical default) unless the capture
specifically recorded `overflow: hidden`-equivalent clipping behavior.

`renderChildrenInto`'s existing `layoutAlign: "STRETCH"` handling (for
CSS `align-items: stretch`, ADR — see `layout.ts`'s `mapCounterAlign`)
now skips any child marked `ABSOLUTE` by the step above — `layoutAlign`
only has meaning for a child still participating in the Auto Layout
flow; setting it on an `ABSOLUTE` child would be a meaningless no-op at
best, so it's skipped for clarity rather than relying on Figma to
silently ignore it.

### Why this is the smallest correct fix, not a workaround

- No hardcoded offsets, no component-specific special-casing — one
  general mechanism, applied uniformly by node TYPE (every `render*`
  function), not by name or structure.
- The Auto Layout frame itself is never disabled, never converted to
  `layoutMode: "NONE"`, never stripped of its padding/gap/alignment
  properties — it remains a real, editable Figma Auto Layout frame.
  `layoutPositioning: "ABSOLUTE"` is ITSELF a first-class, Figma-
  supported, UI-visible feature ("Absolute position" toggle in Figma's
  own right panel) for exactly this situation — an intentional design
  choice Figma exposes, not an obscure escape hatch being repurposed.
- COMPONENT / INSTANCE / FRAME / GROUP / TEXT / VECTOR / IMAGE node
  types, and the parent-child hierarchy itself, are completely
  unchanged — `placeInParent` only ever sets two properties
  (`layoutPositioning`, then `x`/`y`) on nodes that were already being
  created exactly as before.
- Nothing is rasterized, nothing is flattened, no vector became an
  image or vice versa.

### Rejected: disabling Auto Layout on affected frames entirely

Considered — if children are all going to be `ABSOLUTE` anyway, why not
skip enabling Auto Layout (`layoutMode`) in the first place for a frame
whose children will all be exempted from it? Rejected because Design IR
frames can (and often do) mix children needing pixel-exact captured
positions with children that should genuinely participate in the flow
(a frame's own padding/gap/alignment can still matter for a manual
future edit in Figma, and a child that ISN'T marked absolute — none, in
the reporter's specific fixture, but a real possibility in general —
still benefits from a genuinely live Auto Layout frame). Keeping
`layoutMode` set and marking children absolute individually, exactly the
way `placeInParent` decides per-child, preserves both cases correctly
without the renderer needing to guess up front which frames "really
need" Auto Layout to stay off.

## Tests

- `packages/figma-plugin/test/rfdImportPositioning.test.ts` (NEW): four
  tests against the reporter's own real `ClaudeNavigation.rfd`
  (committed as `test/fixtures/ClaudeNavigation.rfd`) — a sanity check
  that the fixture genuinely exercises nested Auto Layout (a false-
  positive-proof precondition), a full recursive position comparison of
  every frame/group/text/shape/image node in the "Tab Navigation"
  component against its Design IR bounds, an explicit check that every
  Auto-Layout-parented child actually got marked
  `layoutPositioning: "ABSOLUTE"`, and a check that the fixture's
  near-zero (`display:contents`-derived) frames have `clipsContent:
  false`.
- `packages/figma-plugin/test/fakeFigma/createFakeFigma.ts` (enhanced,
  not just consumed): `x`/`y` became a real accessor pair that
  simulates Figma's actual documented behavior — assigning either is a
  no-op for a non-`ABSOLUTE` child of an Auto-Layout parent, exactly
  the fact this whole bug hinges on. This is a genuine capability
  upgrade to the shared test harness, not a test-specific hack — the
  file's own pre-existing top-of-file doc comment ("NOT a
  re-implementation of Figma's rendering/geometry engine... proves the
  renderer called the correct API, not that this looks right in real
  Figma") is explicitly updated to note this ONE specific fact
  (Auto-Layout's position-override behavior) is now faithfully modeled,
  precisely because it was the exact fact the OLD fake's plain-field
  `x`/`y` couldn't have caught this class of bug at all. `clipsContent`
  (defaulting to `true`, matching real Figma) and `layoutPositioning`
  (defaulting to `"AUTO"`, matching real Figma, and present as a real
  own-key from node creation — the actual reason an early version of
  this fix's own regression test initially, incorrectly, failed: the
  fake hadn't been initializing it at all, so `"layoutPositioning" in
  child"` was false for every node before this was corrected) were
  added as real, always-present fields for the same reason.
- Full pre-existing `figma-plugin` suite (82 tests before this ADR) re-
  run against the ENHANCED (stricter) fake and passing completely
  unmodified — meaningful because the enhanced fake is now CAPABLE of
  catching this exact bug class, so a clean pass here is evidence the
  fix is complete for every scenario the existing suite already covers,
  not merely "didn't crash."
- Full workspace: 743 tests, all 6 packages, zero regressions.
