/**
 * Pipeline checkpoint persistence — the one reusable place that writes the
 * major intermediate artifacts of the generate_design_ir → export_design_
 * artifact pipeline to disk as concrete, inspectable JSON, and reads them
 * back.
 *
 * Why this exists: the pipeline historically passed a `DesignDocument`
 * purely in memory from generate_design_ir to export_design_artifact, and a
 * document that had been through a JSON stringify/parse round-trip (e.g. a
 * client that forwards one tool's raw text result as the next tool's input,
 * or any boundary that drops a field) could arrive with `assets` undefined,
 * producing a raw `args.document.assets is not iterable` deep in export with
 * no on-disk artifact to inspect or reproduce. Persisting each major stage
 * to disk makes the boundary explicit and inspectable: every stage writes a
 * real JSON file, and export consumes a *reconstructed* document read back
 * from disk rather than an in-memory object handed off across the boundary.
 *
 * Versioning (ADR 0017): each component's checkpoints live under
 * `.reactfig/checkpoints/<component>/v<NNN>/`, one directory per
 * generation. A new generation never overwrites a previous one — it
 * allocates the next version number instead — so `SessionCard v002` and
 * `SessionCard v003` can coexist and be diffed against each other. This
 * module owns version *allocation* and *resolution* (by listing directory
 * names only, never by reading checkpoint JSON contents — see
 * `listVersions` below); the separate, higher-level `checkpoint-map.json`
 * index (checkpointMap.ts) exists purely so an external reader (a resumed
 * agent session, `diff_design_ir`) can discover "what's the latest version,
 * what stage did it reach, is it stale" without opening any of these
 * directories at all. checkpoint.ts never depends on checkpointMap.ts —
 * the map is a disposable, regeneratable index over what's here, not the
 * other way around (ADR 0017 §5, §21).
 *
 * Design decisions (see PROMPT.md and ADR 0017):
 *  - One version-scoped directory per generation, under the project's
 *    existing `.reactfig/` convention (screenshots already live at
 *    `.reactfig/screenshots/`).
 *  - Reuses `@reactfig/core`'s `stableStringify`/`stableParse` for
 *    deterministic JSON (sorted keys, pretty-printed) — the same
 *    convention `@reactfig/artifact`'s pack() uses — and
 *    `validateDesignIR` for the design-ir/v1 check. No new dependency, no
 *    new package, no reimplementation of any of these.
 *  - Atomic-ish writes: write to a sibling temp file then rename over the
 *    final path, so a crashed write never leaves a half-written JSON file
 *    masquerading as a valid checkpoint.
 *  - Successful checkpoints are never deleted: if a later stage fails, the
 *    earlier files remain on disk for debugging (PROMPT.md §6). A stale
 *    checkpoint (source changed since it was generated) is likewise never
 *    deleted — it stays available for historical diffing (ADR 0017 §9).
 *  - All serialization/write/read errors surface as thrown, useful errors —
 *    nothing is swallowed (PROMPT.md §1).
 */

import { mkdir, writeFile, rename, readFile, rm, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { stableStringify, stableParse, validateDesignIR, assertDesignIR, type DesignDocument, type ValidationResult } from "@reactfig/core";
import { debugLog } from "@reactfig/model";
import type { CapturePlan } from "./capturePlan.js";

/**
 * The fixed filenames for each persisted stage, inside a version-scoped
 * checkpoint directory. Kept as constants so the directory layout is
 * documented in one place and both the writer and reader agree on it.
 */
export const CHECKPOINT_FILES = {
  evidence: "evidence.json",
  interpretation: "interpretation.json",
  designIr: "design-ir.json",
  validation: "validation.json",
  manifest: "manifest.json",
  capturePlan: "capture-plan.json",
} as const;

export type CheckpointName = keyof typeof CHECKPOINT_FILES;

/**
 * A handle to one component's version-scoped checkpoint directory.
 * Produced by `openVersionedCheckpointDir` (write side, allocates the next
 * version) or `resolveCheckpointRef` (read side, resolves an existing
 * version) and threaded through a pipeline run so every stage writes to
 * the same directory and a later reader (export, merge, diff, resume)
 * reads the same one back.
 */
export interface CheckpointDir {
  /** Absolute path to the version directory (e.g. `<root>/.reactfig/checkpoints/SessionCard/v002`). */
  path: string;
  /** The sanitized component name this checkpoint belongs to. */
  id: string;
  /** The version number this directory represents (1-based). */
  version: number;
}

/** Zero-padded `v001`-style label — the directory name for a given version number. */
export function versionLabel(version: number): string {
  return `v${String(version).padStart(3, "0")}`;
}

/** Absolute path to a stage's checkpoint file within a version directory. */
export function checkpointFile(dir: CheckpointDir, name: CheckpointName): string {
  return join(dir.path, CHECKPOINT_FILES[name]);
}

function componentBase(projectRoot: string, componentName: string, options: { rootDir?: string } = {}): { base: string; id: string; componentDir: string } {
  const base = options.rootDir ?? join(projectRoot, ".reactfig", "checkpoints");
  const id = sanitizeRequestId(componentName);
  return { base, id, componentDir: join(base, id) };
}

/**
 * Lists the version numbers that currently exist for a component by
 * reading directory *names* only — never opening manifest.json or any
 * other checkpoint file inside them. This is the cheap operation the
 * whole versioning system relies on instead of the checkpoint map: it's
 * always correct (there's no separate index that can drift out of sync
 * with it) and cheap enough (one `readdir` of a handful of small
 * directory names) to call on every version allocation/resolution without
 * needing the map at all. The map exists for a different job — see the
 * module doc comment above and checkpointMap.ts.
 */
async function listVersions(componentDir: string): Promise<number[]> {
  let entries: string[];
  try {
    entries = await readdir(componentDir);
  } catch {
    return [];
  }
  const versions: number[] = [];
  for (const entry of entries) {
    const match = /^v(\d+)$/.exec(entry);
    if (match) versions.push(Number(match[1]));
  }
  return versions.sort((a, b) => a - b);
}

/**
 * Allocates and creates the *next* version directory for a component —
 * the write-side counterpart to `resolveCheckpointRef`. A new generation
 * for the same component never overwrites a previous one: this always
 * creates a fresh `v<N+1>` directory, one higher than the current max.
 *
 * Guards against two concurrent generations for the same component both
 * computing the same "next" version (a real possibility since allocation
 * and creation aren't a single atomic filesystem operation): tries a
 * non-recursive `mkdir` on the candidate version directory and, if it
 * already exists (`EEXIST`), retries with the next number up, bounded so
 * a persistent unrelated failure can't loop forever.
 *
 * `rootDir` is overridable purely for tests; production callers omit it.
 */
export async function openVersionedCheckpointDir(
  projectRoot: string,
  componentName: string,
  options: { rootDir?: string } = {}
): Promise<CheckpointDir> {
  const { id, componentDir } = componentBase(projectRoot, componentName, options);
  await mkdir(componentDir, { recursive: true });

  const MAX_ATTEMPTS = 50;
  let candidate = (await listVersions(componentDir)).at(-1) ?? 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    candidate += 1;
    const dir = join(componentDir, versionLabel(candidate));
    try {
      await mkdir(dir, { recursive: false });
      return { path: dir, id, version: candidate };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue; // another concurrent call just took this version — try the next one
      throw err;
    }
  }
  throw new Error(`openVersionedCheckpointDir: could not allocate a free version for "${id}" under ${componentDir} after ${MAX_ATTEMPTS} attempts`);
}

/**
 * Resolves an *existing* checkpoint version directory without creating
 * one — the read-side counterpart to `openVersionedCheckpointDir`.
 *
 * `ref` is a checkpoint reference string in one of three forms:
 *  - `"ComponentName"` or `"ComponentName@latest"` — the highest version
 *    currently on disk for that component.
 *  - `"ComponentName@vN"` (or `"ComponentName@N"`) — that specific version.
 *
 * Resolution reads directory *names* only (via `listVersions`), never
 * checkpoint file contents, so it works even when `checkpoint-map.json` is
 * missing, stale, or was never written. Throws a clear, path-inclusive
 * error when the component has no checkpoints at all, or when a specific
 * requested version doesn't exist — `readCheckpoint`/`readValidatedDesignIr`
 * called against the result throw their own clear errors for a missing
 * *file* inside an existing version directory, so this only needs to
 * guard the "no such component/version" case.
 *
 * `rootDir` is overridable purely for tests; production callers omit it.
 */
export async function resolveCheckpointRef(
  projectRoot: string,
  ref: string,
  options: { rootDir?: string } = {}
): Promise<CheckpointDir> {
  const at = ref.lastIndexOf("@");
  const rawComponent = at === -1 ? ref : ref.slice(0, at);
  const rawVersion = at === -1 ? undefined : ref.slice(at + 1);
  const { id, componentDir } = componentBase(projectRoot, rawComponent, options);

  let version: number;
  if (rawVersion !== undefined && rawVersion !== "latest") {
    const match = /^v?(\d+)$/.exec(rawVersion);
    if (!match) {
      throw new Error(
        `invalid checkpoint reference "${ref}": expected "<component>", "<component>@latest", or "<component>@vN" (got version part "${rawVersion}")`
      );
    }
    version = Number(match[1]);
    const versions = await listVersions(componentDir);
    if (!versions.includes(version)) {
      throw new Error(
        `checkpoint reference "${ref}" not found: component "${id}" has version(s) [${versions.map(versionLabel).join(", ") || "none"}] under ${componentDir}`
      );
    }
  } else {
    const versions = await listVersions(componentDir);
    if (versions.length === 0) {
      throw new Error(`no checkpoints found for component "${id}" under ${componentDir} — run generate_design_ir first`);
    }
    version = versions.at(-1)!;
  }
  return { path: join(componentDir, versionLabel(version)), id, version };
}

/**
 * Read-only lookup of the latest existing version directory for a
 * component, or null if none exists yet — the non-throwing counterpart to
 * `resolveCheckpointRef` (which throws when there's nothing to resolve).
 * Used by `openOrResumeVersionedCheckpointDir` (checkpointMap.ts) to check
 * whether there's anything to potentially resume from before allocating a
 * fresh version.
 */
export async function resolveLatestCheckpointDirIfExists(
  projectRoot: string,
  componentName: string,
  options: { rootDir?: string } = {}
): Promise<CheckpointDir | null> {
  try {
    return await resolveCheckpointRef(projectRoot, componentName, options);
  } catch {
    return null;
  }
}

/**
 * A sibling checkpoint version of the one actually resolved/used, that
 * looks like it may hold captured evidence for a DIFFERENT instance/state
 * of the same component that never made it into the merge.
 */
export interface DivergentSiblingVersion {
  version: number;
  /** The selector(s) this sibling version's own capture(s) targeted. */
  selectors: string[];
}

/**
 * Detects a specific, real failure mode this project has actually shipped
 * (see docs/adr/0024-divergent-checkpoint-version-detection.md): a caller
 * captures what should have been ONE component's multiple variants (e.g.
 * StatCard's neutral/success/warning tones) as SEPARATE
 * `generate_design_ir` calls — one per on-page position, each targeting a
 * different positional selector directly (`:nth-of-type(1)`,
 * `:nth-of-type(2)`, `:nth-of-type(3)`) — instead of ONE call using the
 * `variants` argument (ADR 0019). Each such call is, correctly per
 * ADR-0017 §2, a legitimately different capture request against
 * unchanged source, so each one gets its OWN checkpoint version rather
 * than being merged into a shared one. `resolveCheckpointRef` then
 * silently resolves the component name to only the LATEST of those
 * versions — every other version's genuinely-captured, genuinely-
 * different evidence is simply never looked at again, with nothing
 * anywhere recording that it once existed. The result: every instance of
 * that component in a merged Dashboard silently renders the SAME single
 * captured state (whichever position was captured last), because that's
 * the only evidence the merge ever had access to — not a merge bug, a
 * total absence of the other instances' evidence by the time merge runs.
 *
 * This function is the detection half of the fix: given the version that
 * was actually resolved (`resolvedVersion`), it looks at every OTHER
 * version on disk for the same component and flags one as a "divergent
 * sibling" when ALL of the following hold:
 *  - the resolved version's own design-ir is a plain `component` (not a
 *    `componentSet`) — a componentSet means multi-variant capture
 *    already succeeded correctly (ADR-0019/0020) and there's nothing to
 *    warn about;
 *  - the sibling is ALSO a plain `component` (a sibling that's itself a
 *    componentSet is a separate, unrelated generation, not evidence of
 *    this specific mistake);
 *  - the sibling's own capture(s) used a DIFFERENT selector than the
 *    resolved version's — the actual, structural signature of "these
 *    were captured as separate positional snapshots," checked directly
 *    rather than by diffing visual content (which would need to reinvent
 *    a notion of "meaningfully different" this project already has good
 *    reasons not to guess at).
 *
 * Deliberately NOT a claim that the sibling's content should have been
 * included, or a guess at what variant it represents — just a factual,
 * checkable signal that it exists, differs in exactly the way this known
 * failure mode produces, and was excluded.
 */
export async function findDivergentSiblingVersions(
  projectRoot: string,
  componentName: string,
  resolvedVersion: number,
  options: { rootDir?: string } = {}
): Promise<DivergentSiblingVersion[]> {
  const { componentDir } = componentBase(projectRoot, componentName, options);
  const versions = await listVersions(componentDir);
  if (versions.length <= 1) return [];

  const readVersion = async (version: number): Promise<{ kind: string | null; selectors: string[] }> => {
    const dir: CheckpointDir = { path: join(componentDir, versionLabel(version)), id: sanitizeRequestId(componentName), version };
    const designIr = await tryReadCheckpoint<DesignDocument>(dir, "designIr");
    const plan = await tryReadCheckpoint<CapturePlan>(dir, "capturePlan");
    return {
      kind: designIr?.components?.[0]?.kind ?? null,
      selectors: (plan?.captures ?? []).map((c) => c.selector).filter((s): s is string => typeof s === "string"),
    };
  };

  const resolved = await readVersion(resolvedVersion);
  if (resolved.kind !== "component") return []; // already a componentSet — multi-variant capture worked

  const resolvedSelectors = new Set(resolved.selectors);
  const results: DivergentSiblingVersion[] = [];
  for (const version of versions) {
    if (version === resolvedVersion) continue;
    const sibling = await readVersion(version);
    if (sibling.kind !== "component") continue;
    const differs = sibling.selectors.length > 0 && sibling.selectors.some((s) => !resolvedSelectors.has(s));
    if (differs) results.push({ version, selectors: sibling.selectors });
  }
  return results;
}

/**
 * Writes one completed capture's raw evidence to its own small file under
 * this version directory's `captures/` subfolder — reusing exactly the
 * same atomic write-then-rename pattern `writeCheckpoint` uses for the
 * fixed-name stage files, just at a caller-chosen filename (the capture's
 * deterministic id — see capturePlan.ts) rather than one of
 * `CHECKPOINT_FILES`'s fixed names, since a component can have any number
 * of individual captures. Stored separately from `evidence.json` (which
 * holds the *assembled* ComponentEvidence covering all captures) so a
 * resumed run can reconstruct exactly what an already-"completed" capture
 * produced without recapturing it or waiting for every capture to finish
 * before persisting anything.
 */
export async function writeCaptureArtifact(dir: CheckpointDir, captureId: string, data: unknown): Promise<string> {
  const filePath = join(dir.path, "captures", `${captureId}.json`);
  debugLog("checkpoint write started", { checkpoint: "capture", path: filePath, component: dir.id, version: dir.version });
  const json = stableStringify(data);
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(tmpPath, json, "utf8");
    await rename(tmpPath, filePath);
    debugLog("checkpoint write finished", { checkpoint: "capture", path: filePath, component: dir.id, version: dir.version });
    return filePath;
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`checkpoint write failed (capture ${captureId}) at ${filePath}: ${message}`);
  }
}

/** Reads a single capture artifact back, or null if it doesn't exist — the expected case for a capture that was never completed (still pending, or failed) rather than an exceptional one. */
export async function tryReadCaptureArtifact<T = unknown>(dir: CheckpointDir, captureId: string): Promise<T | null> {
  const filePath = join(dir.path, "captures", `${captureId}.json`);
  try {
    const text = await readFile(filePath, "utf8");
    return stableParse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Writes one stage's checkpoint: deterministically serialized JSON, created
 * in a sibling temp file and renamed over the final path so a crashed write
 * can never leave a partial file behind. Returns the absolute path written.
 *
 * Logs `checkpoint write started` / `checkpoint write finished` (type, path,
 * component/version) via the shared debug logger — but never the document
 * body (PROMPT.md §7). Any serialization or filesystem error is thrown, not
 * swallowed.
 */
export async function writeCheckpoint(
  dir: CheckpointDir,
  name: CheckpointName,
  data: unknown
): Promise<string> {
  const filePath = checkpointFile(dir, name);
  debugLog("checkpoint write started", { checkpoint: name, path: filePath, component: dir.id, version: dir.version });

  const json = stableStringify(data);
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;

  try {
    // Parent dir is created by openVersionedCheckpointDir, but re-assert it
    // — a caller could write a checkpoint to a fresh directory without
    // going through openVersionedCheckpointDir first, and a missing parent
    // would turn a benign write into an opaque ENOENT.
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(tmpPath, json, "utf8");
    await rename(tmpPath, filePath);
    debugLog("checkpoint write finished", { checkpoint: name, path: filePath, component: dir.id, version: dir.version });
    return filePath;
  } catch (err) {
    // Best-effort cleanup of the temp file so a failed write doesn't litter
    // the directory; never masks the original error, which we rethrow.
    await rm(tmpPath, { force: true }).catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`checkpoint write failed (${name}) at ${filePath}: ${message}`);
  }
}

/**
 * Reads one stage's checkpoint back into a structural object via
 * `stableParse` — the mirror of `writeCheckpoint`'s `stableStringify`, so
 * a write-then-read round-trips to a structurally identical object
 * (PROMPT.md: in-memory IR === JSON.stringify → disk → JSON.parse).
 *
 * Logs `checkpoint read started` / `checkpoint read finished`. Throws with a
 * path-inclusive message on any read or parse error (never swallowed).
 */
export async function readCheckpoint<T = unknown>(dir: CheckpointDir, name: CheckpointName): Promise<T> {
  const filePath = checkpointFile(dir, name);
  debugLog("checkpoint read started", { checkpoint: name, path: filePath, component: dir.id, version: dir.version });
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`checkpoint read failed (${name}) at ${filePath}: ${message}`);
  }
  let parsed: unknown;
  try {
    parsed = stableParse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`checkpoint parse failed (${name}) at ${filePath}: ${message} — the file is not valid JSON`);
  }
  debugLog("checkpoint read finished", { checkpoint: name, path: filePath, component: dir.id, version: dir.version });
  return parsed as T;
}

/** Returns null instead of throwing when the checkpoint file doesn't exist — used for optional reads (e.g. patching a manifest that may not have been written yet) where a missing file is an expected, not exceptional, case. */
export async function tryReadCheckpoint<T = unknown>(dir: CheckpointDir, name: CheckpointName): Promise<T | null> {
  try {
    return await readCheckpoint<T>(dir, name);
  } catch {
    return null;
  }
}

/**
 * Reads the persisted design-ir/v1 checkpoint back and validates it with the
 * project's existing validator before it can be consumed by export — this is
 * the explicit serialization/deserialization boundary the prompt requires:
 * export must operate on a document reconstructed from disk, not an in-
 * memory object, and that reconstruction must pass the same design-ir/v1
 * check the live pipeline enforces.
 *
 * On failure, throws an error that identifies the checkpoint path, the
 * validation error count, and the first few diagnostics — enough to locate
 * and fix the problem without re-invoking the model or browser
 * (PROMPT.md §4, §6). The design-ir.json checkpoint itself is left on disk.
 */
export async function readValidatedDesignIr(dir: CheckpointDir): Promise<DesignDocument> {
  const document = await readCheckpoint<DesignDocument>(dir, "designIr");
  const validation = validateDesignIR(document);
  if (!validation.valid) {
    const detail = validation.errors
      .slice(0, 10)
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(
      `checkpointed design-ir/v1 failed validation at ${dir.path} ` +
        `(${validation.errors.length} error${validation.errors.length === 1 ? "" : "s"}): ${detail} — ` +
        "refusing to export; the design-ir.json checkpoint remains on disk for inspection"
    );
  }
  return document;
}

/**
 * A convenience for the generate pipeline: validate a freshly constructed
 * document and persist both the design-ir and its validation result. Keeps
 * the "validate then persist the validation diagnostics" ordering in one
 * place and guarantees validation.json reflects the same document that was
 * written to design-ir.json.
 */
export async function writeDesignIrAndValidation(
  dir: CheckpointDir,
  document: DesignDocument
): Promise<{ designIrPath: string; validationPath: string; validation: ValidationResult }> {
  const validation = validateDesignIR(document);
  const designIrPath = await writeCheckpoint(dir, "designIr", document);
  const validationPath = await writeCheckpoint(dir, "validation", validation);
  return { designIrPath, validationPath, validation };
}

// ---------------------------------------------------------------------------
// Checkpoint manifest (ADR 0017 §4)
// ---------------------------------------------------------------------------

/** Bumped only if the on-disk checkpoint *directory layout* itself changes in an incompatible way — distinct from the design-ir/v1 schema version and from the per-component version number a manifest describes. See ADR 0017 §3. */
export const CHECKPOINT_LAYOUT_VERSION = 2;

/** Identifies which build of this pipeline produced a checkpoint — reused as-is from the string generateDesignIr.ts already stamped onto evidence.json's `analyzerVersion`, so it's recorded once here rather than duplicated as a second literal. */
export const PIPELINE_VERSION = "@reactfig/mcp@0.1.0";

export const MANIFEST_STAGES = ["sourceInspection", "capture", "interpretation", "designIr", "validation", "export"] as const;
export type ManifestStage = (typeof MANIFEST_STAGES)[number];
export type StageStatus = "not_started" | "in_progress" | "completed" | "failed";

export interface CheckpointManifestSource {
  /** Path to the source file, relative to the project root — absent for a synthetic checkpoint with no single source file (e.g. a merge_design_ir_checkpoints result combining several components). */
  file?: string;
  /** `sha256:<hex>` of the source file's content at generation time (git.ts's hashFileContent), or of the merged document's own content for a synthetic checkpoint — see mergeDesignIrCheckpoints.ts. */
  contentHash: string;
  /** HEAD commit at generation time, when Git was available. Absent in a non-Git project or if `git` failed for any reason (git.ts never throws for this). */
  gitCommit?: string;
}

export interface CheckpointManifest {
  checkpointVersion: number;
  pipelineVersion: string;
  designIrVersion: "design-ir/v1";
  component: string;
  source: CheckpointManifestSource;
  stages: Record<ManifestStage, StageStatus>;
  artifacts: Partial<Record<Exclude<CheckpointName, "manifest">, string>>;
  validation: { valid: boolean; errorCount: number } | null;
  createdAt: string;
  updatedAt: string;
}

/** A fresh manifest with every stage "not_started" and no artifacts recorded yet — the shape `openVersionedCheckpointDir` callers should write immediately after creating the directory, then patch as stages complete via `patchManifest`. */
export function initialManifest(component: string, source: CheckpointManifestSource, now: () => string = () => new Date().toISOString()): CheckpointManifest {
  const timestamp = now();
  const stages = Object.fromEntries(MANIFEST_STAGES.map((s) => [s, "not_started"])) as Record<ManifestStage, StageStatus>;
  return {
    checkpointVersion: CHECKPOINT_LAYOUT_VERSION,
    pipelineVersion: PIPELINE_VERSION,
    designIrVersion: "design-ir/v1",
    component,
    source,
    stages,
    artifacts: {},
    validation: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** Reads a version directory's manifest.json, or null if it hasn't been written yet (e.g. a checkpoint directory from before ADR 0017, or one whose first write hasn't happened). Never throws for a missing file — a missing manifest is an expected transitional state, not an error. */
export async function readManifest(dir: CheckpointDir): Promise<CheckpointManifest | null> {
  return tryReadCheckpoint<CheckpointManifest>(dir, "manifest");
}

/**
 * Read-modify-write update of one version directory's manifest.json: merges
 * `patch.stages` and `patch.artifacts` into whatever's already there
 * (rather than replacing them wholesale) so each pipeline stage only needs
 * to report what it itself completed, and always refreshes `updatedAt`.
 * If no manifest exists yet, `base` supplies the starting point (typically
 * `initialManifest(...)`).
 */
export async function patchManifest(
  dir: CheckpointDir,
  patch: {
    stages?: Partial<Record<ManifestStage, StageStatus>>;
    artifacts?: Partial<Record<Exclude<CheckpointName, "manifest">, string>>;
    validation?: { valid: boolean; errorCount: number } | null;
  },
  base: CheckpointManifest,
  now: () => string = () => new Date().toISOString()
): Promise<CheckpointManifest> {
  const existing = (await readManifest(dir)) ?? base;
  const merged: CheckpointManifest = {
    ...existing,
    stages: { ...existing.stages, ...patch.stages },
    artifacts: { ...existing.artifacts, ...patch.artifacts },
    validation: patch.validation !== undefined ? patch.validation : existing.validation,
    updatedAt: now(),
  };
  await writeCheckpoint(dir, "manifest", merged);
  return merged;
}

/**
 * Makes an arbitrary request identifier safe as a single filesystem path
 * segment: collapses anything that isn't `[A-Za-z0-9._-]` to `_`. This is
 * what makes a caller-supplied component name safe to use as a directory
 * name on every common filesystem — and keeps concurrent calls for
 * different components from colliding.
 */
export function sanitizeRequestId(requestId: string): string {
  const cleaned = String(requestId).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned : "default";
}

/** Re-exports for callers that only need the assertion form. */
export { assertDesignIR };
