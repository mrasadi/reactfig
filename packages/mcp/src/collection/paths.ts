import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * `.reactfig/collections/` — a sibling of `.reactfig/checkpoints/` and
 * `.reactfig/screenshots/`, under the same project-root convention
 * (already gitignored: see the root .gitignore's existing `.reactfig/`
 * entry). Kept as its own top-level directory, not nested under
 * checkpoints/, so the "collection is not a checkpoint" boundary is
 * visible on disk, not just in code.
 */
export function collectionsRootDir(projectRoot: string, overrideRootDir?: string): string {
  return overrideRootDir ?? join(projectRoot, ".reactfig", "collections");
}

export function collectionDir(root: string, collectionId: string): string {
  return join(root, collectionId);
}

export function manifestPath(dir: string): string {
  return join(dir, "manifest.json");
}

export function selectionDir(dir: string, selectionId: string): string {
  return join(dir, "selections", selectionId);
}

export function selectionEvidencePath(dir: string, selectionId: string): string {
  return join(selectionDir(dir, selectionId), "evidence.json");
}

export function selectionScreenshotPath(dir: string, selectionId: string): string {
  return join(selectionDir(dir, selectionId), "screenshot.png");
}

/** Agent Continuation (docs/adr/0027) — where the persisted "developer clicked Done/Continue" signal lives, sibling to manifest.json. */
export function continuationPath(dir: string): string {
  return join(dir, "continuation.json");
}

/** `col_<12 hex chars>` — same id style as capturePlan.ts's `cap_<12 hex>`. */
export function generateCollectionId(): string {
  return `col_${randomBytes(6).toString("hex")}`;
}

/** `sel_<3-digit order>` — stable, human-readable, and naturally sorts in capture order on disk (`selections/sel_001`, `selections/sel_002`, ...). */
export function generateSelectionId(order: number): string {
  return `sel_${String(order).padStart(3, "0")}`;
}
