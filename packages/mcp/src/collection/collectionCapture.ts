import { resolve as resolvePath } from "node:path";
import { interpretDomSnapshot, type RawDomSnapshot, type RenderCapture } from "@reactfig/analyzer";
import type { CaptureRequest } from "../tools/generateDesignIr.js";
import type { CollectionSelection } from "./types.js";
import { readJsonAtomic } from "./atomicFile.js";

/**
 * The one integration point between Interactive Capture and the existing
 * generate_design_ir pipeline: implements the exact same
 * `(request: CaptureRequest) => Promise<RenderCapture>` contract as
 * playwrightCapture.ts's `createPlaywrightCapture`, but reads a
 * previously-persisted `RawDomSnapshot` from disk instead of driving a
 * live browser. generate_design_ir_from_capture.ts wires this in as
 * `GenerateDesignIrContext.captureComponent` and otherwise calls the
 * unmodified `generateDesignIrTool` — every downstream stage (evidence
 * assembly, AI interpretation, Design IR, checkpointing, merge, export)
 * runs exactly as it does for a normal, browser-driven `generate_design_ir`
 * call, with no branching on where the evidence came from.
 *
 * Deliberately does not attempt to honor `request.viewport`/`interactionState`
 * against the persisted evidence — an interactive selection is a single
 * confirmed snapshot of one on-screen moment, not a resizable/replayable
 * render (see docs/architecture.md's Interactive Capture MVP scope: no
 * variant/interaction-state capture during live selection yet).
 */
export function createCollectionCapture(selection: CollectionSelection, collectionDir: string): (request: CaptureRequest) => Promise<RenderCapture> {
  return async (request: CaptureRequest): Promise<RenderCapture> => {
    const evidenceAbsolutePath = resolvePath(collectionDir, selection.evidencePath);
    let raw: RawDomSnapshot;
    try {
      raw = await readJsonAtomic<RawDomSnapshot>(evidenceAbsolutePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Interactive capture evidence missing or unreadable for selection "${selection.selectionId}" at ${evidenceAbsolutePath}: ${message}`);
    }

    return {
      label: request.label,
      viewport: request.viewport,
      viewportLabel: request.viewportLabel,
      propValues: request.propValues,
      interactionState: undefined,
      dom: interpretDomSnapshot(raw),
      screenshot: { path: resolvePath(collectionDir, selection.screenshotPath), width: raw.rect.width, height: raw.rect.height },
      contextScreenshot: null,
      capturedUrl: selection.url,
      capturedAt: selection.capturedAt,
      // The selection was resolved and confirmed by the developer visually
      // in the browser at capture time, not by a selector guess evaluated
      // after the fact — there is no "matched more than one element"
      // ambiguity to report the way a live, selector-driven capture has
      // (see captureComponent.ts's own matchCount / verifyCapturedOwner).
      matchCount: 1,
    };
  };
}
