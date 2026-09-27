import { mkdir, writeFile, rename, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { stableStringify, stableParse } from "@reactfig/core";
import { debugLog } from "@reactfig/model";

/**
 * Same write-to-temp-file-then-rename pattern as checkpoint.ts's
 * `writeCheckpoint` — a crashed write can never leave a half-written JSON
 * file masquerading as a valid one. Not reused directly from checkpoint.ts
 * because that module's write path is keyed on a fixed `CheckpointName`
 * enum inside a component+version directory (`CheckpointDir`); a
 * collection's files (manifest.json, one metadata.json/evidence.json per
 * selection) don't fit that shape and aren't part of the checkpoint
 * versioning system at all (see collection/README in docs — a collection
 * is a pre-pipeline artifact, a checkpoint is a pipeline-stage artifact).
 */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const json = stableStringify(data);
  const tmpPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmpPath, json, "utf8");
    await rename(tmpPath, path);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`collection: atomic write failed at ${path}: ${message}`);
  }
}

export async function readJsonAtomic<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return stableParse(raw) as T;
}

export async function tryReadJsonAtomic<T>(path: string): Promise<T | null> {
  try {
    return await readJsonAtomic<T>(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return null;
    debugLog("collection: read failed (non-ENOENT)", { path, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
