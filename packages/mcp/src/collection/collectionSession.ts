import { writeFile, mkdir, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { RawDomSnapshot } from "@reactfig/analyzer";
import { debugLog } from "@reactfig/analyzer";
import type { CollectionManifest, CollectionSelection, OutputFormat } from "./types.js";
import {
  createManifest,
  addSelection,
  updateSelection,
  removeSelection as removeSelectionFromManifest,
  beginFinalize,
  completeFinalize,
  readCollectionManifest,
  writeCollectionManifest,
  setCollectionOutputFormat,
  setSelectionOutputFormat,
  CollectionStateError,
} from "./collectionManifest.js";
import {
  collectionsRootDir,
  collectionDir,
  selectionDir,
  selectionEvidencePath,
  selectionScreenshotPath,
  generateCollectionId,
  generateSelectionId,
} from "./paths.js";
import { writeJsonAtomic } from "./atomicFile.js";

export interface CapturedSelectionInput {
  url: string;
  pageTitle: string;
  componentPath: string[] | null;
  selector: string;
  tag: string;
  rect: { x: number; y: number; width: number; height: number };
  rawSnapshot: RawDomSnapshot;
  screenshot: Buffer;
  /** Output Intent chosen for THIS selection in the overlay's output picker at confirm time — see docs/architecture.md's Output Intent section. Absent means "use the collection's default" (types.ts's `resolveOutputFormat`). */
  outputFormat?: OutputFormat;
}

/** A small, browser-facing view of the manifest — what the overlay panel actually renders (see overlayScript.ts's `__reactfigApplyState`). Keeps removed selections (shown struck through in the log) but nothing else the developer doesn't need. */
export interface CollectionSummary {
  collectionId: string;
  status: CollectionManifest["status"];
  selections: Array<{ selectionId: string; order: number; status: CollectionSelection["status"]; componentPath: string[] | null; url: string }>;
}

export function summarize(manifest: CollectionManifest): CollectionSummary {
  return {
    collectionId: manifest.collectionId,
    status: manifest.status,
    selections: manifest.selections.map((s) => ({ selectionId: s.selectionId, order: s.order, status: s.status, componentPath: s.componentPath, url: s.url })),
  };
}

/**
 * Owns one collection's on-disk state and lifecycle. Every method here is
 * plain filesystem I/O — no Playwright, no browser, no network — so the
 * whole capture-and-persist path (the part §7/§32 of the brief calls
 * "extremely important" to get right) is testable without a live browser
 * binary. collectionBrowser.ts is the separate, thin layer that drives an
 * actual Playwright page and calls `captureSelection`/`remove`/`finalize`
 * here in response to the overlay's bridge events.
 *
 * A CollectionSession is disposable and re-creatable: `resume` reopens an
 * existing collection directory in a brand new process by reading its
 * manifest back off disk — there is no in-memory state here that a
 * process restart could lose (see docs/architecture.md, "Recovery").
 */
export class CollectionSession {
  private manifest: CollectionManifest;
  readonly dir: string;

  private constructor(manifest: CollectionManifest, dir: string) {
    this.manifest = manifest;
    this.dir = dir;
  }

  get collectionId(): string {
    return this.manifest.collectionId;
  }

  getManifest(): CollectionManifest {
    return this.manifest;
  }

  static async create(options: { projectRoot: string; entryUrl: string; collectionsRootDir?: string; defaultOutputFormat?: OutputFormat }): Promise<CollectionSession> {
    const root = collectionsRootDir(options.projectRoot, options.collectionsRootDir);
    const collectionId = generateCollectionId();
    const dir = collectionDir(root, collectionId);
    const manifest = createManifest(collectionId, options.projectRoot, options.entryUrl, undefined, options.defaultOutputFormat);
    await writeCollectionManifest(dir, manifest);
    debugLog("collection created", { collectionId, dir });
    return new CollectionSession(manifest, dir);
  }

  /** Reopens an existing, on-disk collection — the basis for both "resume an interrupted collection after a browser/process restart" (docs/architecture.md, Recovery) and simple status polling from a separate MCP tool call than the one that started the session. */
  static async resume(options: { projectRoot: string; collectionId: string; collectionsRootDir?: string }): Promise<CollectionSession> {
    const root = collectionsRootDir(options.projectRoot, options.collectionsRootDir);
    const dir = collectionDir(root, options.collectionId);
    const manifest = await readCollectionManifest(dir);
    if (!manifest) {
      throw new CollectionStateError(`No interactive capture collection "${options.collectionId}" found under ${root}.`);
    }
    return new CollectionSession(manifest, dir);
  }

  /**
   * Persists one confirmed selection: evidence.json and screenshot.png
   * written first (each via its own atomic write-then-rename), THEN the
   * manifest updated to reference them — never the reverse, so a crash
   * between the two steps leaves, at worst, an orphaned evidence file
   * next to a manifest that doesn't yet mention it, rather than a
   * manifest entry pointing at files that don't exist (see
   * docs/architecture.md, "Recovery": one failed/interrupted selection
   * must never corrupt the rest of the collection).
   */
  async captureSelection(input: CapturedSelectionInput): Promise<CollectionManifest> {
    const order = this.manifest.selections.length + 1;
    const selectionId = generateSelectionId(order);
    const dir = selectionDir(this.dir, selectionId);
    const evidencePath = selectionEvidencePath(this.dir, selectionId);
    const screenshotPath = selectionScreenshotPath(this.dir, selectionId);

    const selection: CollectionSelection = {
      selectionId,
      order,
      status: "capturing",
      url: input.url,
      pageTitle: input.pageTitle,
      componentPath: input.componentPath,
      selector: input.selector,
      tag: input.tag,
      rect: input.rect,
      capturedAt: new Date().toISOString(),
      evidencePath: `selections/${selectionId}/evidence.json`,
      screenshotPath: `selections/${selectionId}/screenshot.png`,
      ...(input.outputFormat ? { output: { format: input.outputFormat } } : {}),
    };

    this.manifest = addSelection(this.manifest, selection);
    await writeCollectionManifest(this.dir, this.manifest);

    try {
      await mkdir(dir, { recursive: true });
      await writeJsonAtomic(evidencePath, input.rawSnapshot);
      await writeScreenshotAtomic(screenshotPath, input.screenshot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debugLog("collection: selection capture failed", { selectionId, error: message });
      this.manifest = updateSelection(this.manifest, selectionId, { status: "failed", error: message });
      await writeCollectionManifest(this.dir, this.manifest);
      // Re-thrown, not swallowed (CORE ARCHITECTURAL RULE) — the caller
      // (collectionBrowser.ts) surfaces this to the developer via the
      // overlay; the collection itself is left intact, with every
      // previously-successful selection still captured.
      throw err;
    }

    this.manifest = updateSelection(this.manifest, selectionId, { status: "captured" });
    await writeCollectionManifest(this.dir, this.manifest);
    debugLog("collection: selection captured", { selectionId, componentPath: input.componentPath });
    return this.manifest;
  }

  async remove(selectionId: string): Promise<CollectionManifest> {
    this.manifest = removeSelectionFromManifest(this.manifest, selectionId);
    await writeCollectionManifest(this.dir, this.manifest);
    return this.manifest;
  }

  /** Sets (or clears) the collection-level default Output Intent — see types.ts's `resolveOutputFormat`. */
  async setOutputFormat(format: OutputFormat | undefined): Promise<CollectionManifest> {
    this.manifest = setCollectionOutputFormat(this.manifest, format);
    await writeCollectionManifest(this.dir, this.manifest);
    return this.manifest;
  }

  /** Sets (or clears) one selection's Output Intent override — see types.ts's `resolveOutputFormat`. */
  async setSelectionOutputFormat(selectionId: string, format: OutputFormat | undefined): Promise<CollectionManifest> {
    this.manifest = setSelectionOutputFormat(this.manifest, selectionId, format);
    await writeCollectionManifest(this.dir, this.manifest);
    return this.manifest;
  }

  async finalize(): Promise<CollectionManifest> {
    this.manifest = beginFinalize(this.manifest);
    await writeCollectionManifest(this.dir, this.manifest);
    this.manifest = completeFinalize(this.manifest);
    await writeCollectionManifest(this.dir, this.manifest);
    debugLog("collection finalized", { collectionId: this.collectionId, selectionCount: this.manifest.selections.length });
    return this.manifest;
  }

  /** Re-reads the manifest from disk — used by get_interactive_capture_status so a poll always reflects whatever the live browser session (a different in-memory CollectionSession instance, possibly in the same process) has persisted since this instance was created. */
  async refresh(): Promise<CollectionManifest> {
    const manifest = await readCollectionManifest(this.dir);
    if (manifest) this.manifest = manifest;
    return this.manifest;
  }
}

async function writeScreenshotAtomic(path: string, data: Buffer): Promise<void> {
  const tmpPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmpPath, data);
    await rename(tmpPath, path);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`collection: screenshot write failed at ${path}: ${message}`);
  }
}
