# ADR 0018: Per-instance content overrides (Issue.md Fix 2c), and a component
# build-order bug it exposed

## Status
Accepted. Implements Issue.md's Fix 2c ("instance-level content
customization during merge") as a single general mechanism, and fixes a
real, independently-reproducible rendering bug (`buildComponents`
populating component masters in array order instead of dependency order)
that Fix 2c's own end-to-end test caught. Fix 1 (auto-variant-discovery)
and Fix 3 (Avatar dual-mode capture) from Issue.md are **not** implemented
— see "What this doesn't fix" below.

## Context

`Dashboard_example.rfd` renders with three visually identical StatCards
and three visually identical SessionCards (screenshot: `Dashboard-
rendered.png`) instead of the intended per-instance data (`Dashboard-
default.png`, the target design). Issue.md diagnosed five symptoms across
two root causes and proposed five fixes. This work implements the
highest-leverage one.

Inspecting the actual persisted checkpoint
(`.reactfig/checkpoints/merged-Dashboard/v002/design-ir.json`) confirmed
the diagnosis directly: all three StatCard instance nodes share one
`componentRef` pointing at the same `comp_stat_card`, whose root bakes in
one fixed pair of text nodes ("12" / "Sessions this week"). Nothing in
the schema, the merge step, or the renderer had any notion of "same
component, different data per instance." A `propertyOverrides` field
already existed on `InstanceNode` (`packages/core/src/types.ts`) and was
even diffed (`diff.ts`) — but nothing ever *wrote* to it, and nothing
*read* it at render time. It was dead weight, not a partial
implementation.

Two other things were verified directly rather than assumed:
- **Fix 5 (border)** and **Fix 4 (header text truncation)** are already
  correctly handled by this codebase — `packages/figma-plugin`'s existing
  test suite (419 tests, all passing before this change) includes
  regression tests explicitly named for these ("real reported failure:
  StatCard's border-left accent stripe not rendering", mixed-textAlign,
  font-family truncation). No further work was needed there.
- The real `StatCard` checkpoint (`.reactfig/checkpoints/StatCard/v001/
  design-ir.json`) only ever captured a **top** border
  (`strokeWeights: {top: 1, ...}`) — the colored left accent stripe seen
  in the target screenshot was never captured at all, in any checkpoint.
  That's a capture-time gap requiring a live dev-server re-run, out of
  reach in this environment (see "What this doesn't fix").

## Decision

Add one general mechanism — a per-instance list of node-level content
overrides — rather than Issue.md's proposed `dynamicTextNodes` role/
placeholder metadata (2a) plus separate structural fixes for Badge tone
(part of Fix 1) and Avatar color-coding (Fix 3). The same mechanism
covers all three: StatCard/SessionCard text, Badge tone (text + fill),
and a reasonable approximation of Avatar color-coding (fill-swap; see
limitations below) — without needing Fix 1's dev-server middleware for
prop-injected re-capture, which isn't feasible in a sandboxed,
browser-less environment and is a materially larger change than the
reported bug requires.

### 1. Schema / types (`packages/core/src/types.ts`,
   `schema/design-ir.v1.schema.json`)

```ts
export interface InstanceNode extends NodeBase {
  type: "instance";
  componentRef: ...;
  propertyOverrides?: Record<string, string | number | boolean>; // pre-existing, unused — left as-is
  overrides?: InstanceOverride[]; // new
  layout?: Layout;
}

export interface InstanceOverride {
  path: number[];
  characters?: string;
  fills?: Fill[];
  strokes?: Stroke[];
}
```

`path` is a flat sequence of child-array indices, walked from the top of
the *referenced component's* root. The key design choice: crossing into
a nested instance (e.g. reaching the Badge instance nested inside a
SessionCard, then further into Badge's own "completed" text) consumes
**no extra index for the crossing itself** — indexing transparently
restarts at the nested instance's own referenced-component root. This
mirrors exactly how a real Figma `InstanceNode.children` mirrors its
`mainComponent`'s tree (including nested instances), so the same flat
path resolves identically whether computed against the Design IR
(`findNodePath`, authoring time) or against a live `InstanceNode` (a
plain repeated `.children[i]` walk, render time) — no special-casing
needed for the crossing at either end. An empty `path` targets the
instance's own root directly (needed for components like Avatar or Badge
whose root has no children of its own).

### 2. `findNodePath` (`packages/core/src/merge.ts`)

```ts
export function findNodePath(document: DesignDocument, componentId: string, targetNodeId: string): number[] | null
```

Locates a node's `path` by id, so a caller building overrides doesn't
hand-count indices — look up the target node's id once (e.g. StatCard's
captured "12" TextNode) and reuse the path for every instance that needs
different data there.

### 3. `mergeDesignDocuments` (`packages/core/src/merge.ts`)

Gained a third, optional parameter:

```ts
mergeDesignDocuments(primary, dependencies, instanceOverrides?: Record<string, InstanceOverride[]>)
```

keyed by the target instance node's own id in `primary`. Applied as a
post-merge pass that walks `primary`'s component trees and attaches
matching overrides to the matching `InstanceNode`s. Only `primary`'s own
instance nodes are addressable — a dependency is a component library
(Avatar, Badge, ...), not a page composition, so "the second StatCard on
the Dashboard" only ever makes sense relative to `primary`.

### 4. MCP tools (`packages/mcp/src/tools/mergeDesignIrDocuments.ts`,
   `mergeDesignIrCheckpoints.ts`, `server.ts`)

Both `merge_design_ir_documents` and `merge_design_ir_checkpoints` gained
an `instanceOverrides` argument (same shape, threaded straight through to
`mergeDesignDocuments`), with a zod schema documenting `findNodePath` as
the intended way to compute `path`.

### 5. Renderer (`packages/figma-plugin/src/code/render/renderNode.ts`)

`renderInstance` now calls `applyInstanceOverrides(instance, node.overrides,
...)` immediately after `componentNode.createInstance()`: walks each
override's `path` as a flat `.children[i]` sequence against the just-
created Figma `InstanceNode`, then sets `.characters` (awaiting
`loadFontAsync` first, same as the primary text-rendering path — Figma
requires this), `.fills`, and/or `.strokes` via the existing
`applyFills`/`applyStrokes` helpers (now exported as `MinimalFillNode`/
`MinimalStrokeNode` for this use). A path that doesn't resolve, or a
`characters` override aimed at a non-text node, produces a warning and is
skipped — never a thrown error.

## A second, independent bug this exposed:
## `buildComponents` populated masters in the wrong order

Wiring this up end-to-end against the *real* Dashboard checkpoint (not a
synthetic fixture — see "Verification" below) surfaced every override
failing to resolve, with warnings like `override path [0] does not
resolve to a node`. The cause was not the new code: `buildComponents`
(`packages/figma-plugin/src/code/render/components.ts`) populated each
component master's content in `document.components` **array order**.
`mergeDesignDocuments` always places the primary document first — so for
a multi-level merge (`Dashboard` primary, `StatCard`/`SessionCard`/
`Avatar`/`Badge`/`Button` as dependencies), `comp_dashboard` was being
populated *before* `comp_stat_card`. At that point, `comp_dashboard`'s
own root render hits a StatCard `instance` node and calls
`componentNode.createInstance()` on `comp_stat_card`'s master — which
existed (so no "not defined" warning) but had **zero children yet**,
since its own turn in the populate loop hadn't come up. Exactly like real
Figma, `createInstance()` mirrors whatever the master has *at that exact
call* — it does not retroactively pick up content added to the master
afterward. The clone was therefore empty, and every override path into it
failed to resolve.

This is a real, pre-existing latent bug, not one this change introduced —
it just never had a symptom before, since nothing previously needed a
nested instance's *content* to be correct at render time (only its
existence, for placement/sizing). It's directly in the path of Fix 2c's
target scenario (Dashboard → StatCard, and Dashboard → SessionCard →
Badge, both multi-level), so it's fixed as part of this change:
`buildComponents`'s sub-pass B now populates masters in **dependency
order** (topological, via `collectReferencedComponentIds` + a DFS with a
cycle guard) instead of array order — a component's own root is only
populated once every component it instantiates is already populated. The
outdated doc comment on `buildComponents` (which claimed array-order
population was sufficient once ids were merely *registered*) has been
corrected in the same change.

## Two follow-up fixes (found via post-implementation review, not the original report)

After the initial implementation, a deliberate self-review of this new
code (not a new user report) turned up two more issues, both fixed in
this same change:

1. **`findNodePath` always resolved a ComponentSet to its first variant**,
   ignoring which variant a `variant`-kind instance ref actually points
   at (`node.componentRef.variantId` was computed but never read in the
   crossing branch). Variants commonly differ in structure — an extra
   icon child, a different wrapper — so this could silently compute a
   path against the wrong variant's tree. Fixed: `rootOf` now accepts an
   optional `variantId` and looks that variant up by id; the
   instance-crossing branch passes it through for `variant`-kind refs.
   Regression test: `packages/core/test/merge.test.ts`, "honors the
   specific variantId a `variant` instance ref points at" — targets a
   node id that only exists on Button's `secondary` variant through an
   instance referencing exactly that variant, and confirms the *other*
   variant's equivalent node is correctly unreachable through it.

2. **The cycle guard in `buildComponents`'s new dependency-order populate
   was silent.** A genuinely circular instance reference (e.g. a
   recursive `TreeNode`/`Accordion` pattern, A instantiates B, B
   instantiates A) doesn't hang — the guard already prevented that — but
   one side of the cycle would still populate before its own dependency
   was ready, the same "empty nested instance" failure mode this whole
   change exists to fix, just for the one case a cycle makes
   unavoidable, and with no visibility into why. Fixed: tripping the
   guard now pushes a warning naming the component and explaining the
   cycle, instead of returning quietly. Regression test:
   `packages/figma-plugin/test/render/components.test.ts`, "circular
   instance references" — a two-component A↔B cycle, asserting it
   doesn't hang, both still resolve with no "not defined" warning, and
   the new cycle warning is present.

Full suite after these two fixes: **484 tests passing, 0 failing**
(up from 482 after the main fix, 419 at baseline).



- **Fix 1 (auto-variant-discovery via a dev-server middleware)**: not
  implemented. Requires a live browser/dev-server round-trip to inject
  props and re-render each variant combination — infeasible in this
  sandboxed session, and a materially larger change (`findVariantProps`,
  new capture endpoints, `generateDesignIrTool` changes) than the
  reported bug needs, since Fix 2c's override mechanism covers the same
  visible symptoms (Badge tone, StatCard/SessionCard content) without it.
- **Fix 3 (Avatar dual-mode: image vs. color-coded circle+status-dot)**:
  the real `Avatar` checkpoint only ever captured an `<img>`-rooted
  component (`type: "image"`). This change can *tint* that image node via
  a `fills` override (a `fills: [{type:"solid",...}]` override on an
  `image`-rooted instance replaces the image paint with a solid color —
  demonstrated working in the corrected Dashboard artifact), which
  approximates the target's color-coded look, but does not reproduce the
  structural difference (no status dot, no initials, still an image node
  under the hood). A proper fix needs a second, differently-shaped
  capture — another live-browser dependency.
- **Fix 5's left-accent StatCard border**: as noted above, the *data*
  needed for this (a captured `border-left` side, distinct from the
  existing captured top border) was never captured in
  `.reactfig/checkpoints/StatCard`, in any version. This change doesn't
  fabricate that value; a re-capture against the running app is needed.
- **Header subtitle truncation (Fix 4)**: already correct in this
  codebase (verified via the existing, passing regression test) — no
  change made or needed.

Every one of the above requires either a live Playwright/dev-server
round-trip against the running `examples/sample-react-app`, or new
capture data that doesn't exist in any checkpoint on disk — neither is
available in this sandboxed environment. They're called out explicitly
rather than approximated further or silently skipped.

## Verification

- Full monorepo: `pnpm -r run build` and `pnpm -r run typecheck` clean;
  `pnpm -r run test` — **482 tests passing, 0 failing** (baseline before
  this change: 419 passing, 0 failing — net +63 new tests, 0
  regressions):
  - `packages/core`: `findNodePath` (path computation, including the
    "crosses into a nested instance's own root" case) and
    `mergeDesignDocuments`'s `instanceOverrides` (attaches to the right
    instance, leaves untouched siblings alone, no-ops on an unknown id).
  - `packages/figma-plugin`: `applyInstanceOverrides` unit tests (text,
    cross-instance fills, unresolvable-path warning, wrong-node-type
    warning) — required extending the test fake (`createFakeFigma.ts`)
    so `createInstance()` clones the master's child tree, matching real
    Figma's instance-mirrors-master behavior (previously untested since
    nothing needed it).
  - `packages/mcp`: `instanceOverrides` threaded through both
    `merge_design_ir_documents` and `merge_design_ir_checkpoints` over
    the real MCP stdio client boundary (`connectedClient()`), not just
    the underlying function.
  - **`packages/figma-plugin/test/dashboardOverridesIntegration.test.ts`**:
    the actual end-to-end proof. Not a synthetic fixture — packs/unpacks
    the real corrected `.rfd` (below) through the identical pipeline an
    import would use (`unpack` → `renderDocument` → fake Figma), and
    asserts the three StatCards render `["12", "Sessions this week"]`,
    `["6.8", "Avg. speaking score"]`, `["1", "Missed sessions"]` (not
    three identical cards), and the three SessionCards render distinct
    learner name/time/Badge-status-text/Badge-fill-color combinations.
- **The real artifact**: `design/Dashboard_example.fixed.rfd`, regenerated
  from the actual on-disk checkpoints
  (`.reactfig/checkpoints/{Dashboard,Sidebar,Header,StatCard,
  SessionCard,Avatar,Badge,Button}`) via `merge_design_ir_checkpoints`
  with `instanceOverrides` supplying the three StatCards' and three
  SessionCards' distinct data — exports with **zero warnings** (other
  than the pre-existing, unrelated "Avatar photo not embedded" notice
  from exporting with `fetchAssets: false`).

## Alternatives considered

- **Issue.md's `dynamicTextNodes` (role/placeholder metadata on
  `ComponentDef`)**: describes *that* a text node is dynamic and *what
  kind* of data it holds, but still needs a second mechanism to actually
  supply per-instance values — it's metadata, not a fix by itself. The
  chosen `InstanceOverride` mechanism supplies the values directly and
  needs no separate metadata layer.
- **Auto-detecting `.map()`-rendered dynamic regions in the analyzer**
  (Issue.md 2b): would remove the need for a caller to supply
  `instanceOverrides` by hand, but doesn't change what data goes in each
  instance — the underlying per-instance data still has to come from
  somewhere (the live DOM at capture time, one instance at a time). Given
  the capture pipeline already visits each `.map()`-rendered instance
  individually during a real `generate_design_ir` run, wiring
  auto-detected regions to auto-populated `instanceOverrides` is a
  natural follow-up, but is orthogonal to — and not required for — fixing
  the reported bug.
