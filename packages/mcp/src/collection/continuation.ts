import { EventEmitter } from "node:events";
import { continuationPath } from "./paths.js";
import { writeJsonAtomic, tryReadJsonAtomic } from "./atomicFile.js";

/**
 * The persisted "Selection Done, Continue" event (docs/adr/0027, Feature
 * C — Interactive Capture → Agent Continuation). Written ONCE per
 * collection, at the moment the developer clicks the overlay's own
 * Done/Continue button — see collectionBrowser.ts's `__reactfigMarkDone`
 * bridge function, which is the only writer of this file.
 *
 * Deliberately a plain on-disk marker, not something that lives only in
 * server memory: a poll (get_interactive_capture_status) or a fresh
 * server process after a restart can both observe it the same way,
 * exactly the same "disk is the source of truth" principle the rest of
 * Interactive Capture already follows for the manifest itself (see
 * docs/architecture.md, "COLLECTION COMPLETE").
 */
export interface ContinuationSignal {
  signaledAt: string;
  /** Always "browser-done-button" for now — the only writer. Kept as a field (not hardcoded at every read site) so a future second trigger (e.g. a CLI command) doesn't need a schema change, only a new value here. */
  source: "browser-done-button";
}

export async function writeContinuationSignal(dir: string): Promise<ContinuationSignal> {
  const signal: ContinuationSignal = { signaledAt: new Date().toISOString(), source: "browser-done-button" };
  await writeJsonAtomic(continuationPath(dir), signal);
  return signal;
}

export async function readContinuationSignal(dir: string): Promise<ContinuationSignal | null> {
  return tryReadJsonAtomic<ContinuationSignal>(continuationPath(dir));
}

/**
 * In-process push, ON TOP OF the persisted marker above — not a
 * replacement for it. Scoped per-collectionId, one-shot per emit (see
 * `onceSignaled`). This is the "explicit continuation/control signal"
 * architecture docs section 19 asks for, preferred over emulating a
 * keystroke: `attachInteractiveBrowser` (or whatever owns the live
 * session) can `bridge.onceSignaled(collectionId, cb)` and react
 * immediately in-process, no polling needed, for exactly as long as this
 * server process is alive for that collection.
 *
 * What this does NOT claim to do: push a notification across the MCP
 * transport into the agent's own turn. This SDK's tool-call model is
 * request/response (see docs/adr/0013's own disclosed timeout
 * constraints, which is why start/status/finalize is polled rather than
 * one blocking call in the first place) — nothing server-side can inject
 * a new turn into an agent conversation that isn't already waiting on a
 * call. Where an MCP client's transport DOES support server-initiated
 * notifications, a future tool can subscribe here and forward one; where
 * it doesn't, the fallback is the documented, OPT-IN, non-core adapter in
 * continuationKeystrokeAdapter.ts (docs section 19's explicitly-requested
 * escape hatch) — never wired in by default.
 */
export class ContinuationBridge {
  private readonly emitter = new EventEmitter();

  signal(collectionId: string): void {
    this.emitter.emit(collectionId);
  }

  /** Registers a one-shot listener for this collectionId's next signal(). Returns an unsubscribe function. */
  onceSignaled(collectionId: string, listener: () => void): () => void {
    this.emitter.once(collectionId, listener);
    return () => this.emitter.removeListener(collectionId, listener);
  }
}
