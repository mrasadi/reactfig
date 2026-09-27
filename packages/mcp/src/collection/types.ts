/**
 * Interactive Capture's data model — a Collection is the developer-driven,
 * pre-pipeline evidence-gathering session; a CollectionSelection is one
 * confirmed selection within it. This is deliberately NOT another
 * checkpoint system: a checkpoint (checkpoint.ts) is versioned per
 * component and represents *processed pipeline state*; a collection has no
 * component identity yet and represents *raw developer-selected evidence*.
 * See docs/architecture.md, "Interactive Capture" for the full boundary.
 */

export type CollectionStatus = "created" | "collecting" | "finalizing" | "completed";

export type SelectionStatus = "capturing" | "captured" | "removed" | "failed";

/**
 * Output Intent (docs/adr/0027) — the output format a developer picks
 * inside Interactive Capture itself, instead of only through the
 * OpenCode/Claude prompt. Kept here (not a parallel metadata system) so
 * it's persisted as part of the same manifest the rest of a selection's
 * evidence already lives in — see docs/architecture.md's Output Intent
 * section. "rfd" is the backward-compatible default wherever this is
 * absent, both at the collection and selection level.
 */
export type OutputFormat = "rfd" | "json" | "svg" | "html";

export interface OutputIntent {
  format: OutputFormat;
}

export interface CollectionSelection {
  selectionId: string;
  /** Monotonic — assigned at capture time, preserved across removal (removed selections keep their original order for an honest review log). */
  order: number;
  status: SelectionStatus;
  url: string;
  pageTitle: string;
  /** Best-effort React component-ownership chain, outermost first — see @reactfig/analyzer's resolveComponentBoundary. Null when no React fiber info was available (production build, non-React DOM); the selection is still usable, just without a component name attached. */
  componentPath: string[] | null;
  /** Resolves to exactly this element at capture time — not a durable, refactor-proof selector (see resolveComponentBoundary's own caveat). */
  selector: string;
  tag: string;
  rect: { x: number; y: number; width: number; height: number };
  capturedAt: string;
  /** Relative to the collection's own directory (collectionDir), e.g. "selections/sel_001/evidence.json" — never an absolute path, so a collection stays portable if the project is moved/cloned elsewhere, same convention as checkpointMap.ts's latestCheckpoint. */
  evidencePath: string;
  screenshotPath: string;
  /** Present only when status is "failed" — surfaced to the developer rather than silently dropped (see CORE ARCHITECTURAL RULE: no swallowed capture failures). */
  error?: string;
  /** Selection-level Output Intent override — absent means "use the collection's own default output" (see `CollectionManifest.output` and `resolveOutputFormat`). */
  output?: OutputIntent;
}

export interface CollectionManifest {
  $schema: "https://reactfig.dev/schema/collection-manifest/v1.json";
  collectionId: string;
  status: CollectionStatus;
  createdAt: string;
  finalizedAt: string | null;
  projectRoot: string;
  /** The dev-server URL interactive capture was started against — informational, and the default `url` for a resumed session. */
  entryUrl: string;
  selections: CollectionSelection[];
  /** Collection-level default Output Intent — absent means the pipeline's own backward-compatible default ("rfd") applies (see `resolveOutputFormat`). Settable via start_interactive_capture's `defaultOutputFormat`, or from the overlay's output picker at capture time. */
  output?: OutputIntent;
}

/**
 * Resolves what output format a given (or every) selection should be
 * exported as — selection-level override, else the collection's own
 * default, else the pipeline-wide backward-compatible default "rfd".
 * Pure and total: a manifest written before Output Intent existed (no
 * `output` anywhere) resolves to "rfd" for every selection, exactly what
 * export_design_artifact already assumed — see docs/adr/0027,
 * "Backward compatibility".
 */
export function resolveOutputFormat(manifest: CollectionManifest, selectionId?: string): OutputFormat {
  if (selectionId) {
    const selection = manifest.selections.find((s) => s.selectionId === selectionId);
    if (selection?.output?.format) return selection.output.format;
  }
  return manifest.output?.format ?? "rfd";
}

/** Active selections only, in capture order — the view every consumer (summary UI, finalize, generate_design_ir_from_capture) actually wants; a removed selection is kept in the manifest for audit but excluded everywhere else. */
export function activeSelections(manifest: CollectionManifest): CollectionSelection[] {
  return manifest.selections.filter((s) => s.status === "captured").sort((a, b) => a.order - b.order);
}
