/// <reference types="@figma/plugin-typings" />
import type { DesignDocument } from "@reactfig/core";
import type { RenderContext } from "./types.js";
import { ZERO_BOUNDS } from "./geometry.js";
import { buildComponents } from "./components.js";
import { renderNode } from "./renderNode.js";

export interface RenderResult {
  warnings: string[];
  rootFrameId: string;
}

const IMPORT_NAME_PREFIX = "ReactFig: ";

/**
 * Deterministic, non-overlapping placement for successive imports (per
 * the brief: "avoid random IDs or random naming... use stable names") —
 * scans existing ReactFig-imported frames on the current page and places
 * the next one to the right of all of them, rather than at a random or
 * fixed (overlapping) position.
 */
function computeImportOrigin(figmaApi: typeof figma): { x: number; y: number } {
  const existing = figmaApi.currentPage.children.filter((c) => c.name.startsWith(IMPORT_NAME_PREFIX));
  if (existing.length === 0) return { x: 0, y: 0 };
  const maxRight = Math.max(...existing.map((c) => c.x + c.width));
  return { x: maxRight + 100, y: 0 };
}

function fitToContents(frame: FrameNode): void {
  if (frame.children.length === 0) return;
  const maxRight = Math.max(...frame.children.map((c) => c.x + c.width));
  const maxBottom = Math.max(...frame.children.map((c) => c.y + c.height));
  frame.resize(Math.max(maxRight, 1), Math.max(maxBottom, 1));
}

/**
 * Renders a validated Design IR document into native Figma content.
 * Contains zero AI calls and zero calculation of values the IR already
 * provides — every position/size/color/spacing value is read from
 * `document`, never invented. See docs/figma-plugin/feasibility.md for
 * the full mapping this function's two passes rely on.
 */
export async function renderDocument(
  document: DesignDocument,
  assets: Record<string, Uint8Array>,
  assetMimeTypes: Record<string, string>,
  figmaApi: typeof figma,
  onProgress?: (message: string, current: number, total: number) => void
): Promise<RenderResult> {
  const ctx: RenderContext = {
    figmaApi,
    componentIndex: new Map(),
    assets,
    assetMimeTypes,
    warnings: [],
    loadedFonts: new Set(),
  };

  const origin = computeImportOrigin(figmaApi);
  const rootFrame = figmaApi.createFrame();
  figmaApi.currentPage.appendChild(rootFrame);
  rootFrame.name = `${IMPORT_NAME_PREFIX}${document.name}`;
  rootFrame.x = origin.x;
  rootFrame.y = origin.y;
  rootFrame.layoutMode = "NONE";
  rootFrame.resize(1, 1); // placeholder size, fitToContents() sets the real size once children exist

  const totalPageNodes = document.pages.reduce((sum, page) => sum + page.children.length, 0);
  const total = document.components.length + totalPageNodes;
  let processed = 0;

  onProgress?.("Building components", processed, total);
  await buildComponents(document, ctx, rootFrame);
  processed = document.components.length;

  for (const page of document.pages) {
    for (const node of page.children) {
      onProgress?.(`Rendering ${node.name}`, processed, total);
      await renderNode(node, ZERO_BOUNDS, rootFrame, ctx);
      processed++;
    }
  }

  fitToContents(rootFrame);
  figmaApi.viewport.scrollAndZoomIntoView([rootFrame]);

  return { warnings: ctx.warnings, rootFrameId: rootFrame.id };
}
