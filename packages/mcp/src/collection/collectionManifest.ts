import type { CollectionManifest, CollectionSelection, SelectionStatus, OutputFormat } from "./types.js";
import { manifestPath } from "./paths.js";
import { readJsonAtomic, tryReadJsonAtomic, writeJsonAtomic } from "./atomicFile.js";

/**
 * Thrown for any attempted mutation that violates the collection lifecycle
 * (e.g. adding a selection to an already-finalized collection). Distinct
 * from a plain Error so callers (MCP tool handlers) can surface it as a
 * clear, actionable client error rather than an opaque failure — see
 * CORE ARCHITECTURAL RULE: no silently swallowed or misleading state.
 */
export class CollectionStateError extends Error {}

function assertMutable(manifest: CollectionManifest, action: string): void {
  if (manifest.status === "completed") {
    throw new CollectionStateError(`Collection "${manifest.collectionId}" is already finalized — ${action} is not allowed. Start a new collection instead.`);
  }
}

export function createManifest(
  collectionId: string,
  projectRoot: string,
  entryUrl: string,
  now: () => string = () => new Date().toISOString(),
  defaultOutputFormat?: OutputFormat
): CollectionManifest {
  return {
    $schema: "https://reactfig.dev/schema/collection-manifest/v1.json",
    collectionId,
    status: "created",
    createdAt: now(),
    finalizedAt: null,
    projectRoot,
    entryUrl,
    selections: [],
    ...(defaultOutputFormat ? { output: { format: defaultOutputFormat } } : {}),
  };
}

/** Sets (or clears, when `format` is undefined) the collection-level default Output Intent — see types.ts's `resolveOutputFormat`. Callable at any point before finalization, same mutability rule as any other manifest edit. */
export function setCollectionOutputFormat(manifest: CollectionManifest, format: OutputFormat | undefined): CollectionManifest {
  assertMutable(manifest, "setting the collection's default output format");
  if (format === undefined) {
    const { output: _drop, ...rest } = manifest;
    return rest as CollectionManifest;
  }
  return { ...manifest, output: { format } };
}

/** Sets (or clears) one selection's Output Intent override — see types.ts's `resolveOutputFormat`. */
export function setSelectionOutputFormat(manifest: CollectionManifest, selectionId: string, format: OutputFormat | undefined): CollectionManifest {
  if (format === undefined) {
    assertMutable(manifest, "clearing a selection's output format");
    const index = manifest.selections.findIndex((s) => s.selectionId === selectionId);
    if (index === -1) throw new CollectionStateError(`Collection "${manifest.collectionId}" has no selection "${selectionId}".`);
    const selections = manifest.selections.slice();
    const { output: _drop, ...rest } = selections[index];
    selections[index] = rest as CollectionSelection;
    return { ...manifest, selections };
  }
  return updateSelection(manifest, selectionId, { output: { format } });
}

/** Called once the browser overlay is attached and ready for the developer to select something — the "created" → "collecting" transition. Idempotent: calling it again once already collecting (or finalizing/completed) is a no-op, not an error, since a resumed session re-attaches to a collection that's already past this point. */
export function beginCollecting(manifest: CollectionManifest): CollectionManifest {
  if (manifest.status !== "created") return manifest;
  return { ...manifest, status: "collecting" };
}

export function addSelection(manifest: CollectionManifest, selection: CollectionSelection): CollectionManifest {
  assertMutable(manifest, "adding a selection");
  const withStatus = manifest.status === "created" ? beginCollecting(manifest) : manifest;
  return { ...withStatus, selections: [...withStatus.selections, selection] };
}

/** Updates one selection in place by id — used both to move a selection from "capturing" to "captured"/"failed" once evidence persistence finishes, and to mark one "removed". */
export function updateSelection(manifest: CollectionManifest, selectionId: string, patch: Partial<CollectionSelection>): CollectionManifest {
  assertMutable(manifest, "updating a selection");
  const index = manifest.selections.findIndex((s) => s.selectionId === selectionId);
  if (index === -1) {
    throw new CollectionStateError(`Collection "${manifest.collectionId}" has no selection "${selectionId}".`);
  }
  const selections = manifest.selections.slice();
  selections[index] = { ...selections[index], ...patch };
  return { ...manifest, selections };
}

/** Marks a selection removed rather than deleting its record — see docs/architecture.md: evidence for a removed selection is excluded from finalization but the manifest entry is kept for an honest review log (same "never delete a completed unit of work" convention as checkpoint.ts). */
export function removeSelection(manifest: CollectionManifest, selectionId: string): CollectionManifest {
  return updateSelection(manifest, selectionId, { status: "removed" as SelectionStatus });
}

export function beginFinalize(manifest: CollectionManifest): CollectionManifest {
  assertMutable(manifest, "finalizing");
  return { ...manifest, status: "finalizing" };
}

export function completeFinalize(manifest: CollectionManifest, now: () => string = () => new Date().toISOString()): CollectionManifest {
  if (manifest.status === "completed") return manifest;
  if (manifest.status !== "finalizing") {
    throw new CollectionStateError(`Collection "${manifest.collectionId}" must be "finalizing" before it can complete (currently "${manifest.status}").`);
  }
  return { ...manifest, status: "completed", finalizedAt: now() };
}

export async function readCollectionManifest(dir: string): Promise<CollectionManifest | null> {
  return tryReadJsonAtomic<CollectionManifest>(manifestPath(dir));
}

export async function readCollectionManifestOrThrow(dir: string): Promise<CollectionManifest> {
  return readJsonAtomic<CollectionManifest>(manifestPath(dir));
}

export async function writeCollectionManifest(dir: string, manifest: CollectionManifest): Promise<void> {
  await writeJsonAtomic(manifestPath(dir), manifest);
}
