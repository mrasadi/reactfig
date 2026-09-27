# Changelog

> **A note on version numbers:** entries below `v0.1.0` (`v2.0.0`
> through `v2.6.1`) use ReactFig's internal build-iteration numbering
> from before this was a public repository — they predate any package
> being published anywhere. Public versioning, matching the `version`
> field in every package's `package.json` and git tags, starts fresh at
> `v0.1.0` per semver. The technical detail in the older entries is
> still accurate and worth reading if you're tracking down when a
> specific fix landed.

## v0.1.0 — Initial public release

ReactFig is now open source. This release is a snapshot of the pipeline
as it stood after the internal iteration documented below (`v2.0.0` –
`v2.6.1`): capture, analysis, artifact packaging, and Figma/HTML/SVG
export, with 624 tests across the pipeline. See the [README](README.md)
for the package overview and quick start, and
[Known limitations](README.md#known-limitations) for what's not yet
supported.

## v2.6.1 — `display:contents` elements no longer become their own Design IR node

### Fixed

- **A `display:contents`-wrapped subtree (real, visible content) broke
  relative-position math for both HTML flexbox export and, latently, any
  future exporter** — `display:contents` generates no box of its own, so
  its captured bounds are correctly `{0,0,0,0}`, but that degenerate
  value was still being used as a positioning reference for its real
  children. Found by direct inspection of the actual generated HTML for
  a real capture, after ADR 0032's flexbox fix. Fixed at the source:
  `interpretDomSnapshot.ts` now skips any `display:contents` element
  entirely, splicing its children directly into its own parent (matching
  real CSS box-tree semantics) — recursively, for a chain of nested
  wrappers. No exporter needed to change. See
  `docs/adr/0033-display-contents-source-fix.md`.

## v2.6.0 — HTML export: real CSS flexbox, correct nested positioning

### Fixed

- **HTML export used `position:absolute` with globally-offset
  coordinates on every nested element, which CSS interprets as relative
  to the nearest positioned ancestor — compounding the offset at every
  level of nesting** (visible as small positional drift, worsening with
  depth). A captured `layout.mode !== "none"` frame (a real CSS flex
  container in the original page) now becomes genuine CSS flexbox
  (`display:flex`, `flex-direction`, `justify-content`, `align-items`,
  `gap`, `padding`) — the browser's own layout engine places those
  children, not more absolute-positioned boxes. Everything else still
  uses `position:absolute`, now computed correctly relative to each
  node's own immediate parent. See
  `docs/adr/0032-html-export-flexbox-and-relative-positioning.md`.

## v2.5.0 — RFD → Figma import: Auto Layout was silently discarding child positions

### Fixed

- **Children of a captured flex container rendered displaced after RFD
  import, snapping to the correct position only after flattening** —
  root cause: once a Figma frame's Auto Layout (`layoutMode`) is
  enabled, Figma's own layout engine owns every child's position;
  setting `child.x`/`child.y` directly (what the renderer always did)
  is silently ineffective unless that child's `layoutPositioning` is
  explicitly `"ABSOLUTE"` — never being set anywhere. Fixed via a new
  `placeInParent` helper (`geometry.ts`), used by every node type
  (frame/group/text/shape/image/instance) instead of a raw position
  assignment. A related, compounding issue — Figma frames clip their
  contents by default, and this was never set from the Design IR's own
  `clipsContent` field — was fixed alongside it, since it most severely
  affected the exact same real-world shape (a near-zero, `display:
  contents`-derived frame clipping away its own real children). No
  flattening, no rasterizing, no hierarchy or component/instance
  changes — see `docs/adr/0031-rfd-figma-import-autolayout-positioning.md`.

## v2.4.0 — inline SVG icon capture

### Added

- **Inline `<svg>` icons (e.g. Google's search/mic/camera icons) are now
  captured and exported correctly** — previously rendered as invisible
  empty boxes, since Design IR has no vector/path node type and the DOM
  walk had no special handling for `<svg>` elements. An icon is now
  captured whole (its own `outerHTML`, with `currentColor` resolved and
  a `viewBox` synthesized if missing) and represented as an `image`
  node — the same existing node type an `<img>` already uses, via a
  `data:image/svg+xml;base64,...` asset. No new Design IR node type;
  `renderSvg`/`renderHtml`/`.rfd` export all needed zero changes to
  already handle it correctly. See
  `docs/adr/0030-inline-svg-icon-capture.md`.

## v2.3.2 — component-boundary selection on pages with no React at all

### Fixed

- **The overlay's "↑ Parent"/"↓ Child" adjustment buttons did nothing
  useful on a page with no React fiber tree** — "↑ Parent" jumped
  straight to the whole `<body>` instead of stepping up one DOM level,
  and "↓ Child" was a silent no-op. Diagnosed from a real capture of
  google.com's search box: the selected DOM node's own computed style
  genuinely had no background/border/shadow (correctly reported — not a
  rendering or AI-interpretation bug), because the actually-styled
  container was an ancestor with an identical bounding box, and there
  was no working way to step up to it. `resolveComponentBoundary.ts` now
  falls back to plain one-level DOM stepping whenever there's no React
  ownership info anywhere in the ancestor chain; behavior for React apps
  (and React "islands" inside an otherwise plain page) is unchanged. See
  `docs/adr/0029-resolve-component-boundary-non-react-fallback.md`.

## v2.3.1 — real-world capture bug fixes (found testing against google.com)

### Fixed

- **DOM capture no longer walks into `<style>`/`<script>`/other
  non-visual elements** — a real capture of a non-React page (Google's
  homepage) surfaced these tags' raw text content (CSS source) being
  captured as if it were visible component text, landing at nonsensical
  coordinates in SVG/HTML exports. `collectDomSnapshot.ts` now filters
  `style`, `script`, `template`, `noscript`, `link`, `meta`, `title`,
  `head`, `base`, and the SVG-internal definition containers (`defs`,
  `symbol`, `clipPath`, `mask`, `marker`, `pattern`, `metadata`, `desc`)
  out of the DOM walk entirely.
- **`renderSvg`/`renderHtml` now render `dropShadow`/`innerShadow`
  effects** (SVG via `<feDropShadow>` filters, HTML via CSS
  `box-shadow`) — previously silently ignored, so any component whose
  visible outline comes from a shadow rather than a background/border
  exported with no visible content at all.
- **`MAX_TOOL_ITERATIONS` (AI interpretation's tool-call budget) was
  silently `2`, not the documented `5`** — every real (non-trivial)
  interpretation was being cut off almost immediately, before annotating
  a single node, which was the actual cause of components exporting with
  no fills/effects at all (not a capture-evidence gap). Corrected to `5`,
  with a new cross-package test asserting it can't drift out of sync
  with `packages/mcp/src/toolSchemas.ts`'s own documented default again.

See `docs/adr/0028-real-world-capture-bugs-google-search-input.md`.

## v2.3.0 — Output Intent, source-less generation, agent continuation

### Added

- **Output Intent** — choose the output format (`rfd` / `json` / `svg` /
  `html`) inside Interactive Capture itself, instead of only through the
  OpenCode/Claude prompt. Persisted as data on the collection manifest
  (collection-level default, optional per-selection override), resolved
  via the new `resolveOutputFormat`. Defaults to `rfd` everywhere nothing
  else specifies a format — every existing prompt/client keeps working
  unchanged. New MCP tool `export_design_output` generalizes
  `export_design_artifact` (untouched, still works exactly as before) to
  all four formats. New `@reactfig/artifact` exporters: `renderJson`,
  `renderSvg`, `renderHtml`, and a `renderOutput` dispatcher. See
  `docs/adr/0027-output-intent-source-less-generation-and-agent-continuation.md`.
- **Source-less Design IR generation** — `generate_design_ir` (and
  `generate_design_ir_from_capture`) no longer require a `sourceFile`.
  Omit it to generate a Design IR purely from captured DOM structure,
  computed styles, layout geometry, and a screenshot — no React source
  needed. `generate_design_ir_from_capture` computes the required
  checkpoint fingerprint automatically from a selection's own persisted
  evidence. Capture-inferred evidence is marked as such in
  `ComponentEvidence.meta.limitations`, so an inferred structure/name is
  never presented as though React source actually declared it.
- **Interactive Capture → Agent Continuation** — a "Done / Continue"
  button in the overlay lets the developer finish a capture session from
  the browser itself: finalizes the collection, persists a durable
  `continuation.json` signal, and (when available) pushes an in-process
  event via the new `ContinuationBridge`, before closing the browser.
  `get_interactive_capture_status` now reports `continuationPending` /
  `continuationSignaledAt`. A documented, strictly opt-in keystroke-
  emulation fallback (`continuationKeystrokeAdapter.ts`) exists for agent
  surfaces with no other way to resume, and is not wired in by default.

## v2.2.0 — Interactive Capture Mode

### Added

- **Interactive Capture Mode** — an optional, explicitly opt-in way to
  produce `generate_design_ir`'s evidence by clicking a target visually
  in a real browser instead of describing a `url`/`selector` up front.
  Four new MCP tools: `start_interactive_capture`,
  `get_interactive_capture_status`, `finalize_interactive_capture`,
  `generate_design_ir_from_capture`. Normal `generate_design_ir` usage is
  completely unaffected — see `docs/adr/0026-interactive-capture.md` and
  `docs/architecture.md`'s "Interactive Capture Mode" section.
- **`resolveComponentBoundary`** (`@reactfig/analyzer`) — generalizes
  `findComponentInstances.ts`'s React-fiber walk to resolve an arbitrary
  clicked DOM node outward to its nearest component-instance root, with
  a parent/child adjustment for when the automatic guess is wrong.
- A collection's evidence (`.reactfig/collections/<id>/`) is captured
  and persisted incrementally at selection-confirm time, so the browser
  is never a dependency of anything after `finalize_interactive_capture`
  — closing it, or the developer's process restarting, loses nothing
  already confirmed.

## v2.1.1 — variant axis name fallback matching

### Fixed

- **A genuine, previously silent bug**: when a componentSet's confirmed
  variant axis name (e.g. `"cardTone"`, chosen by AI interpretation)
  doesn't textually match the corresponding `perInstanceData` field name
  (e.g. `"tone"`, the raw source data's own field), every instance
  silently defaulted to `variants[0]` with **zero warning**. Found by
  directly reproducing a user-reported failure against the real MCP tool
  rather than trusting an incomplete third-party trace. Fixed with a
  safe, non-guessing fallback: match by value against the axis's own
  known values when the name doesn't match, warning loudly instead of
  guessing when that's ambiguous or impossible. See
  `docs/adr/0025-variant-axis-name-fallback-matching.md`.

## v2.1.0 — divergent checkpoint version detection

### Added

- **`staleCheckpointVersionWarnings`** on `merge_design_ir_checkpoints` —
  detects a real, previously-shipped failure mode: a component captured
  as SEPARATE `generate_design_ir` calls (one per on-page position, each
  targeting a different selector) instead of ONE call using the
  `variants` argument. Previously this silently resolved to whichever
  checkpoint version happened to be latest, with every instance of that
  component rendering identically in the final artifact and no warning
  anywhere. Root-caused directly against a user's real uploaded
  checkpoints and `.rfd` (not a synthetic report) — see
  `docs/adr/0024-divergent-checkpoint-version-detection.md`.

## v2.0.0 — hardening pass

### Added

- **Interaction/pseudo-state capture** (hover/focus/active) — new
  capture-plan shape, real Playwright interaction-driving code, and a
  deterministic `state` variant axis that composes with prop-driven
  axes. **Explicitly flagged as unverified against a real browser** —
  this sandbox has no network access to Playwright's browser binaries.
  See `docs/adr/0023-interaction-state-capture.md` for exactly what is
  and isn't tested.
- **Portal detection** — a static AST check (`detectPortalUsage.ts`)
  surfaces `usesPortal` on a component's source evidence and dependency-
  tree node when it calls `createPortal(...)`, turning a previously
  silent capture gap into an explicit, actionable signal. Full portal
  *capture* (splicing portaled content into its logical parent's
  evidence) remains out of scope — needs live-browser fiber-tree work.
- `conic-gradient()` support (new `conicGradient` Fill type) and
  multi-layer `background-image` support (every comma-separated layer
  now resolves, not just the first) — see
  `docs/adr/0022-conic-gradient-and-multi-layer-backgrounds.md`.
- Variant discovery now also finds variants from repeated static JSX
  call sites with differing literal props, `React.memo`/`forwardRef`
  component-boundary detection, `filter`/`backdrop-filter` blur capture,
  `radial-gradient()` support — see
  `docs/adr/0021-hardening-for-arbitrary-react-components.md`.

### Fixed

- **A real, independent bug found while adding multi-layer backgrounds**:
  `background-color` and `background-image`/gradient fills were pushed
  in the wrong array order — Figma paints *later* `fills[]` entries on
  top, but the code pushed image-then-color, so background-color was
  silently rendering *over* the image/gradient for every component that
  had both. This had been flagged as unverified in ADR-0008 without
  being resolved; fixed as part of the multi-layer work rather than
  built on top of.
- SessionCard Badge status / StatCard tone border (variant resolution +
  nested-instance-boundary evidence loss) — see
  `docs/adr/0020-variant-resolution-and-nested-instance-evidence.md`.
- `docs/adr/0008-ai-orchestration.md` — corrected stale claims about
  border-side sampling and radial/conic-gradient/multi-layer support.

### Known limitations (see ADR-0021/0023 for the full list)

Full portal *capture* (detection only), interaction capture's real-
browser verification, no per-side border *color* (only width), no
`repeating-*-gradient()` variants, no `instanceSwap` component
properties, no Angular/Vue/Svelte support.

### Housekeeping

- Test suite: 555 → 624 across both hardening passes, with fixtures
  built from realistic patterns, not just the sample app's own
  components.
