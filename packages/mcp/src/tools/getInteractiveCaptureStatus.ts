import { CollectionSession } from "../collection/collectionSession.js";
import { activeSelections, type CollectionManifest } from "../collection/types.js";
import { readContinuationSignal, type ContinuationSignal } from "../collection/continuation.js";

export interface GetInteractiveCaptureStatusArgs {
  collectionId: string;
  projectRoot?: string;
}

export interface GetInteractiveCaptureStatusContext {
  projectRoot: string;
  /** If a browser session for this collectionId is still open in this server process, its in-memory CollectionSession is used (and refreshed from disk) rather than opening a second, independent one — see server.ts's active-session registry. */
  getActiveSession?: (collectionId: string) => { session: CollectionSession } | undefined;
}

export interface GetInteractiveCaptureStatusResult {
  manifest: CollectionManifest;
  activeSelectionCount: number;
  removedSelectionCount: number;
  failedSelectionCount: number;
  /** True while a live browser session for this collection is still open in this server process — false doesn't mean the collection is stuck, only that status is being read from disk (e.g. a different process/session started it, or it already finalized and closed). */
  browserAttached: boolean;
  /**
   * Agent Continuation (docs/adr/0027 section 19/20): true once the
   * developer has clicked the overlay's own Done/Continue button for
   * this collection — a durable, on-disk signal (continuation.ts),
   * distinct from `manifest.status === "completed"` only in WHO
   * triggered finalization (the browser vs. an explicit
   * finalize_interactive_capture call); either way, once true, the
   * collection is finalized and generate_design_ir_from_capture is safe
   * to call. Poll this (alongside `manifest.status`) instead of assuming
   * an agent-initiated finalize is the only way a collection becomes
   * usable.
   */
  continuationPending: boolean;
  continuationSignaledAt?: string;
}

/**
 * Read-only poll of a collection's current state — always safe to call
 * repeatedly while the developer is browsing/selecting, and the intended
 * way to check progress instead of blocking a single long-running call
 * (see startInteractiveCapture.ts's doc comment).
 */
export async function getInteractiveCaptureStatusTool(args: GetInteractiveCaptureStatusArgs, ctx: GetInteractiveCaptureStatusContext): Promise<GetInteractiveCaptureStatusResult> {
  const active = ctx.getActiveSession?.(args.collectionId);
  const session = active?.session ?? (await CollectionSession.resume({ projectRoot: ctx.projectRoot, collectionId: args.collectionId }));
  const manifest = await session.refresh();
  const continuation: ContinuationSignal | null = await readContinuationSignal(session.dir);

  return {
    manifest,
    activeSelectionCount: activeSelections(manifest).length,
    removedSelectionCount: manifest.selections.filter((s) => s.status === "removed").length,
    failedSelectionCount: manifest.selections.filter((s) => s.status === "failed").length,
    browserAttached: Boolean(active),
    continuationPending: continuation !== null,
    ...(continuation ? { continuationSignaledAt: continuation.signaledAt } : {}),
  };
}
