import { CollectionSession } from "../collection/collectionSession.js";
import { activeSelections, type CollectionManifest } from "../collection/types.js";
import type { InteractiveBrowserHandle } from "../collection/collectionBrowser.js";

export interface FinalizeInteractiveCaptureArgs {
  collectionId: string;
  /** Close the attached browser (if one is still open in this server process) once finalized. Default true — per docs/architecture.md, the browser is not required after finalization; leaving it open is only useful if the developer wants to keep browsing for an unrelated reason. */
  closeBrowser?: boolean;
  projectRoot?: string;
}

export interface FinalizeInteractiveCaptureContext {
  projectRoot: string;
  getActiveSession?: (collectionId: string) => { session: CollectionSession; browser: InteractiveBrowserHandle } | undefined;
  dropActiveSession?: (collectionId: string) => void;
}

export interface FinalizeInteractiveCaptureResult {
  manifest: CollectionManifest;
  /** Selections available for generate_design_ir_from_capture, in capture order — removed/failed selections are excluded here (they're still visible in `manifest.selections` for an honest audit trail, just not usable as pipeline input). */
  selections: Array<{ selectionId: string; componentPath: string[] | null; url: string; selector: string }>;
  browserClosed: boolean;
}

/**
 * Marks a collection COMPLETE: after this call, the persisted collection
 * — not the live browser — is the source of truth, and every subsequent
 * pipeline stage (generate_design_ir_from_capture onward) reads only from
 * disk. See docs/architecture.md's "COLLECTION COMPLETE" boundary.
 */
export async function finalizeInteractiveCaptureTool(args: FinalizeInteractiveCaptureArgs, ctx: FinalizeInteractiveCaptureContext): Promise<FinalizeInteractiveCaptureResult> {
  const active = ctx.getActiveSession?.(args.collectionId);
  const session = active?.session ?? (await CollectionSession.resume({ projectRoot: ctx.projectRoot, collectionId: args.collectionId }));

  const manifest = await session.finalize();

  let browserClosed = false;
  const shouldClose = args.closeBrowser !== false;
  if (active?.browser && shouldClose) {
    await active.browser.close();
    browserClosed = true;
  }
  if (active) ctx.dropActiveSession?.(args.collectionId);

  return {
    manifest,
    selections: activeSelections(manifest).map((s) => ({ selectionId: s.selectionId, componentPath: s.componentPath, url: s.url, selector: s.selector })),
    browserClosed,
  };
}
