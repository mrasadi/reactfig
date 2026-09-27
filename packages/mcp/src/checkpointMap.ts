/**
 * checkpoint-map.json — a small, regeneratable index over the versioned
 * checkpoints in checkpoint.ts, optimized for one job: letting a new
 * session (or the diff tool) discover "what's the latest checkpoint for
 * this component, what stage did it reach, is it stale" without opening
 * any of the (potentially large) evidence/interpretation/design-ir JSON
 * files those checkpoints contain (ADR 0017 §5, §6).
 *
 * This is deliberately NOT the source of truth. Each component's
 * manifest.json (checkpoint.ts) is authoritative; this file is a summary
 * of the latest manifest per component, kept alongside it purely so a
 * reader doesn't have to list every component's checkpoint directory and
 * open its latest manifest just to answer "what components exist and
 * where are they at". If this file is missing, stale, or corrupted,
 * `rebuildCheckpointMap` reconstructs it from the manifests on disk —
 * the map is never a hard dependency for anything else in this package to
 * function (ADR 0017 §20, §21).
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { stableStringify, stableParse } from "@reactfig/core";
import { readFile, writeFile, rename, mkdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { debugLog } from "@reactfig/model";
import {
  readManifest,
  versionLabel,
  openVersionedCheckpointDir,
  resolveLatestCheckpointDirIfExists,
  tryReadCheckpoint,
  type CheckpointDir,
  type CheckpointManifest,
  type ManifestStage,
  type StageStatus,
} from "./checkpoint.js";
import { mergeCapturePlan, type CapturePlan } from "./capturePlan.js";

export const CHECKPOINT_MAP_SCHEMA_VERSION = 1;

export interface CheckpointMapEntry {
  latestVersion: number;
  /** Directory name of the latest version, e.g. "v003" — not a full path, so the map stays portable if the project is moved/cloned elsewhere. */
  latestCheckpoint: string;
  sourceFile?: string;
  sourceHash: string;
  gitCommit?: string;
  lastCompletedStage: ManifestStage | null;
  valid: boolean;
  /** Path to the latest version's design-ir.json, relative to the project root. */
  designIr: string;
  updatedAt: string;
}

export interface CheckpointMap {
  schemaVersion: number;
  components: Record<string, CheckpointMapEntry>;
}

function emptyMap(): CheckpointMap {
  return { schemaVersion: CHECKPOINT_MAP_SCHEMA_VERSION, components: {} };
}

function mapPath(projectRoot: string, options: { mapPath?: string } = {}): string {
  return options.mapPath ?? join(projectRoot, ".reactfig", "checkpoint-map.json");
}

/** Reads checkpoint-map.json, or an empty map if it doesn't exist yet or fails to parse — a missing/corrupt map is never a hard error; callers needing certainty should follow up with `rebuildCheckpointMap`. */
export async function readCheckpointMap(projectRoot: string, options: { mapPath?: string } = {}): Promise<CheckpointMap> {
  const filePath = mapPath(projectRoot, options);
  try {
    const text = await readFile(filePath, "utf8");
    const parsed = stableParse(text) as CheckpointMap;
    if (!parsed || typeof parsed !== "object" || !parsed.components) return emptyMap();
    return parsed;
  } catch {
    return emptyMap();
  }
}

/** Atomic write, same temp-file-then-rename pattern as checkpoint.ts's writeCheckpoint — a crashed write must never leave a half-written map masquerading as valid (ADR 0017 §20). */
async function writeCheckpointMap(projectRoot: string, map: CheckpointMap, options: { mapPath?: string } = {}): Promise<void> {
  const filePath = mapPath(projectRoot, options);
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await mkdir(join(filePath, ".."), { recursive: true });
  try {
    await writeFile(tmpPath, stableStringify(map), "utf8");
    await rename(tmpPath, filePath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

function entryFromManifest(manifest: CheckpointManifest, dir: CheckpointDir): CheckpointMapEntry {
  const lastCompletedStage =
    ([...manifest.stages ? (Object.keys(manifest.stages) as ManifestStage[]) : []] as ManifestStage[])
      .filter((stage) => (manifest.stages[stage] as StageStatus) === "completed")
      // MANIFEST_STAGES's own declared order (source inspection → ... →
      // export) is the pipeline order; the last *completed* one in that
      // order is "how far this checkpoint got", which is what a resuming
      // reader actually wants — not merely "some stage is done".
      .sort((a, b) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b))
      .at(-1) ?? null;

  return {
    latestVersion: dir.version,
    latestCheckpoint: versionLabel(dir.version),
    sourceFile: manifest.source.file,
    sourceHash: manifest.source.contentHash,
    gitCommit: manifest.source.gitCommit,
    lastCompletedStage,
    valid: manifest.validation?.valid ?? false,
    designIr: join(".reactfig", "checkpoints", manifest.component, versionLabel(dir.version), "design-ir.json"),
    updatedAt: manifest.updatedAt,
  };
}

const STAGE_ORDER: ManifestStage[] = ["sourceInspection", "capture", "interpretation", "designIr", "validation", "export"];

/**
 * Updates (or inserts) one component's entry from its manifest — called
 * after a checkpoint write succeeds (never before), so the map can only
 * ever lag behind reality, never claim a checkpoint exists that isn't
 * fully on disk yet (ADR 0017 §20). A read-modify-write of the whole
 * file; concurrent updates for *different* components racing each other
 * is a real but accepted risk at this project's stated scale (ADR 0017
 * §20's "small, understandable, non-over-engineered" priority) — the
 * worst case is one update briefly overwriting another's, self-healed by
 * the next write to either component, and always recoverable via
 * `rebuildCheckpointMap`.
 */
export async function upsertCheckpointMapEntry(
  projectRoot: string,
  manifest: CheckpointManifest,
  dir: CheckpointDir,
  options: { mapPath?: string } = {}
): Promise<CheckpointMap> {
  const map = await readCheckpointMap(projectRoot, options);
  map.components[manifest.component] = entryFromManifest(manifest, dir);
  await writeCheckpointMap(projectRoot, map, options);
  debugLog("checkpoint map updated", { component: manifest.component, version: dir.version });
  return map;
}

/**
 * Rebuilds checkpoint-map.json from scratch by scanning every component's
 * `.reactfig/checkpoints/<component>/v<N>/manifest.json` — reading only
 * each component's *latest* manifest (a small file), never any
 * evidence/interpretation/design-ir content. This is the recovery path
 * for a missing or corrupted map (ADR 0017 §21): safe to run at any
 * time, and idempotent — rebuilding twice in a row produces the same
 * map, modulo `updatedAt` timestamps already on the manifests it read.
 */
export async function rebuildCheckpointMap(projectRoot: string, options: { rootDir?: string; mapPath?: string } = {}): Promise<CheckpointMap> {
  const checkpointsRoot = options.rootDir ?? join(projectRoot, ".reactfig", "checkpoints");
  const map = emptyMap();

  let componentDirs: string[];
  try {
    componentDirs = await readdir(checkpointsRoot);
  } catch {
    await writeCheckpointMap(projectRoot, map, options);
    return map;
  }

  for (const component of componentDirs) {
    const componentPath = join(checkpointsRoot, component);
    let versionDirs: string[];
    try {
      versionDirs = await readdir(componentPath);
    } catch {
      continue;
    }
    const versions = versionDirs
      .map((name) => /^v(\d+)$/.exec(name))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    const latest = versions.at(-1);
    if (latest === undefined) continue;

    const dir: CheckpointDir = { path: join(componentPath, versionLabel(latest)), id: component, version: latest };
    const manifest = await readManifest(dir);
    if (!manifest) continue; // a version directory with no manifest predates ADR 0017 or failed before its first write — skip rather than fabricate an entry
    map.components[component] = entryFromManifest(manifest, dir);
  }

  await writeCheckpointMap(projectRoot, map, options);
  debugLog("checkpoint map rebuilt", { componentCount: Object.keys(map.components).length });
  return map;
}

// ---------------------------------------------------------------------------
// Resumable capture — the fast "is there anything to resume?" check
// ---------------------------------------------------------------------------

export interface OpenOrResumeResult {
  dir: CheckpointDir;
  /** True when an existing, incomplete checkpoint for this exact revision was found and reused instead of allocating a fresh version. */
  resumed: boolean;
  /** The active capture plan for this run: the freshly-requested one, or — when resumed — that same plan with each entry's persisted status (completed/failed) carried over. */
  plan: CapturePlan;
  /** The resumed checkpoint's existing manifest, so the caller can continue patching it rather than starting a fresh one. Null when a new version was allocated. */
  manifest: CheckpointManifest | null;
}

/**
 * The write-side entry point for resumable multi-capture generation:
 * decides whether this call should continue an interrupted previous
 * attempt (same component, same source content, same requested capture
 * set, capture stage not yet completed) or start a fresh checkpoint
 * version — reusing checkpoint.ts's existing versioned-directory
 * machinery either way, never a second checkpoint mechanism.
 *
 * Deliberately checks the *map* first, not any component's checkpoint
 * files: per this module's whole reason for existing (see the file's
 * top-of-file doc comment) and the "don't reread every checkpoint file
 * just to determine pipeline state" requirement, a component with no
 * entry in checkpoint-map.json at all is conclusively a first-ever
 * generation — no manifest or capture-plan.json needs to be opened to
 * know that. Only when the map says a checkpoint already exists does this
 * lazily load that one component's *latest* manifest + capture-plan.json
 * (two small files) to check whether it's actually resumable.
 */
export async function openOrResumeVersionedCheckpointDir(
  projectRoot: string,
  componentName: string,
  freshPlan: CapturePlan,
  options: { rootDir?: string; mapPath?: string } = {}
): Promise<OpenOrResumeResult> {
  const map = await readCheckpointMap(projectRoot, { mapPath: options.mapPath });

  if (map.components[componentName]) {
    const existing = await resolveLatestCheckpointDirIfExists(projectRoot, componentName, { rootDir: options.rootDir });
    if (existing) {
      const [manifest, persistedPlan] = await Promise.all([
        readManifest(existing),
        tryReadCheckpoint<CapturePlan>(existing, "capturePlan"),
      ]);
      const captureIncomplete = manifest?.stages.capture !== "completed";
      if (manifest && persistedPlan && captureIncomplete && persistedPlan.revisionKey === freshPlan.revisionKey) {
        debugLog("resuming capture plan", { component: componentName, version: existing.version, revisionKey: freshPlan.revisionKey });
        return { dir: existing, resumed: true, plan: mergeCapturePlan(freshPlan, persistedPlan), manifest };
      }
    }
  }

  const dir = await openVersionedCheckpointDir(projectRoot, componentName, { rootDir: options.rootDir });
  return { dir, resumed: false, plan: freshPlan, manifest: null };
}
