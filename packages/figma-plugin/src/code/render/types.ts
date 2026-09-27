/// <reference types="@figma/plugin-typings" />

/**
 * Threaded through every render* function. `figmaApi` is `typeof figma` in
 * production (see code/index.ts); tests inject a lightweight fake typed as
 * `unknown as typeof figma` (see test/fakeFigma/) — the fake only
 * implements the subset of the API this renderer actually calls, which is
 * exactly what "pure renderer tests" (no real Figma) means. See
 * docs/figma-plugin/README.md, "What's tested here, and what isn't."
 */
export interface RenderContext {
  figmaApi: typeof figma;
  /** ComponentDef.id -> ComponentNode, or "<componentSetId>:<variantId>" -> ComponentNode (the individual variant). Populated by components.ts's buildComponents() before any Instance is rendered — see docs/figma-plugin/feasibility.md, "Rendering order." */
  componentIndex: Map<string, ComponentNode>;
  /** assetId -> raw bytes, embedded assets only (matches @reactfig/artifact's UnpackResult.assets). */
  assets: Record<string, Uint8Array>;
  /** assetId -> mimeType, from the artifact manifest — needed to branch raster (createImage) vs SVG (createNodeFromSvg). */
  assetMimeTypes: Record<string, string>;
  /** Non-fatal problems surfaced to the UI at the end of import — missing fonts, missing assets, unresolved instances, unsupported constructs. Never thrown, always collected (see the brief's "do not swallow errors" balanced against "one missing font must not abort the whole document"). */
  warnings: string[];
  /** `${family}::${style}` keys already passed to loadFontAsync this session, to avoid redundant calls. */
  loadedFonts: Set<string>;
}
