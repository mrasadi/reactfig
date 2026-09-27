# @reactfig/figma-plugin

**ReactFig Importer** — imports a `.rfd` artifact and renders it as native,
editable Figma content. See `docs/figma-plugin/feasibility.md` for the
full Design IR → Figma API mapping matrix this renderer is built against,
and `docs/adr/0011-figma-plugin-renderer.md` for the architecture
decisions.

```
ui.tsx (iframe)                          code.ts (sandbox)
  file picker                              renderDocument()
  @reactfig/artifact: checkArtifact/          ├─ buildComponents()   (pass 1)
    unpack/inspect  ────── postMessage ──►    └─ renderNode()        (pass 2)
  base64-encode assets                          ├─ style/typography/layout/assets
                          ◄── postMessage ──     └─ Figma Plugin API
  progress / success / errors
```

No Figma MCP, no Claude Code, no Qwen/Ollama/LiteLLM, no React repository,
no browser/analyzer, no external backend — the plugin's only inputs are an
`.rfd` file and the Figma Plugin API. Zero AI calls anywhere in
`src/code/`.

## Build

```bash
pnpm --filter @reactfig/figma-plugin build
```

Runs `build.mjs`: bundles `src/code/index.ts` → `dist/code.js` (the
sandbox, `platform: "browser"`-ish target with no DOM assumptions) and
`src/ui/main.tsx` → `dist/ui.bundle.js` + `dist/ui.bundle.css`, then
splices both into `src/ui/ui.template.html` to produce `dist/ui.html` —
Figma's `manifest.ui` field requires a single self-contained HTML file, no
external `<script>`/`<link>` tags.

## Install/develop in Figma

1. `pnpm --filter @reactfig/figma-plugin build`
2. In the Figma desktop app: **Plugins → Development → Import plugin from
   manifest…**, select `packages/figma-plugin/manifest.json`.
3. Run the plugin from **Plugins → Development → ReactFig Importer**.
4. Select an `.rfd` file (see `packages/artifact/test/fixtures/design-ir/`
   for ready-made examples — pack one with `@reactfig/artifact`'s `pack()`
   first, e.g. via `packages/artifact/scripts/inspect-cli.ts`'s sibling
   pattern, or from a real `generate_design_ir` → `export_design_artifact`
   MCP run).

`manifest.json` declares `documentAccess: "dynamic-page"` and
`networkAccess: {allowedDomains: ["none"]}` — the plugin never makes a
network request; every asset comes from the artifact itself.

## What's tested here, and what isn't

**A. Pure renderer tests (52 tests, no Figma)** — `test/render/*.test.ts`,
against `test/fakeFigma/createFakeFigma.ts`, a minimal fake of the Figma
Plugin API surface this renderer calls. These prove *"the renderer calls
the correct Figma API with the correct arguments,"* not *"this looks right
when rendered in real Figma"* — there is no real rendering/geometry engine
behind the fake. Covers: node-type dispatch (frame/group/text/shape/
image/instance), layout (flex + none/absolute + the stretch correction),
typography (including font-fallback), fills/strokes/effects/corner-radius,
component/variant construction and naming, instance resolution, and every
documented fallback (missing component, missing asset, empty group).

**B. Artifact integration tests (5 tests)** — `test/artifactIntegration.test.ts`
uses the **real** `@reactfig/artifact` (`pack`/`unpack`) against the
**real, existing** golden fixtures (`packages/artifact/test/fixtures/
design-ir/{button,session-card,avatar}.json` — no Figma-specific copy),
proving the actual portable-artifact pipeline feeds correctly into the
renderer. Still runs through the fake Figma API, so the same caveat as
category A applies to the *rendering* half of these tests.

**C. Real Figma runtime — not verified.** No test in this repository has
been run inside an actual Figma document. `dist/code.js` and `dist/ui.html`
were built for real (`node build.mjs` succeeds, producing genuine bundled
output — verified during this phase, not merely assumed from
`tsc` passing), and `manifest.json`'s shape was checked against Figma's
documented required fields, but installing and running the plugin inside
Figma itself was not possible in this sandboxed environment. Two specific,
called-out assumptions in `docs/figma-plugin/feasibility.md` remain
unverified against a live instance: whether the UI iframe's CSP permits
`ajv`'s runtime `new Function` code generation, and the exact
`postMessage` payload-size/typed-array behavior (mitigated defensively via
base64 encoding either way).

## Known fidelity limitations

See `docs/figma-plugin/feasibility.md`'s matrix for the full list;
highlights:

- Text wrapping is approximated (`textAutoResize: "WIDTH_AND_HEIGHT"`) —
  IR doesn't yet carry a wrap-mode signal.
- Linear gradient angle→transform conversion is a standard formula, not
  pixel-verified against real Figma rendering.
- `ComponentProperty` of type `instanceSwap` is skipped (no default
  component key available in the IR) rather than fabricated.
- An `Instance` referencing a component outside the current document
  (`external:<Name>`, per ADR 0008 — nested components not yet separately
  analyzed) renders as a clearly-labeled placeholder frame, not the real
  component.
- A non-embedded asset (`manifest.assets[].embedded === false`) renders as
  a labeled neutral placeholder, never unrelated imagery.
- Visual (pixel-level) fidelity was explicitly out of scope for this phase
  per the brief — this phase establishes structural correctness,
  deterministic mapping, and component semantics; a real React-vs-Figma
  visual comparison belongs to Phase 7.
