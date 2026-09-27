/**
 * Lightweight, optional Git awareness for the checkpoint system.
 *
 * Git and checkpoints solve different problems (ADR 0017): Git answers
 * "what changed in the source repository"; checkpoints answer "what did
 * the pipeline produce for a given source state". This module only ever
 * enriches a checkpoint's manifest with commit context when Git happens
 * to be available — every function here degrades to `undefined` (never
 * throws) when the project isn't a Git repo, `git` isn't on PATH, or the
 * command fails for any other reason, so the checkpoint/hash/diff system
 * keeps working unchanged in a non-Git environment.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { debugLog } from "@reactfig/model";

const execFileAsync = promisify(execFile);

/** Generous but bounded — a hung `git` process must never hang a generate_design_ir/export call. */
const GIT_TIMEOUT_MS = 5000;

async function runGit(projectRoot: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: projectRoot, timeout: GIT_TIMEOUT_MS });
    return stdout.trim();
  } catch (err) {
    // Covers every failure mode this needs to tolerate: git not
    // installed (ENOENT), not a repo ("not a git repository"), no
    // commits yet ("unknown revision"), or a timeout — all equally
    // "no Git context available right now", never a hard error.
    debugLog("git command unavailable, continuing without Git metadata", {
      args: args.join(" "),
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * The current HEAD commit hash, or undefined if Git is unavailable /
 * this isn't a repo / there are no commits yet. Never throws.
 */
export async function getCurrentGitCommit(projectRoot: string): Promise<string | undefined> {
  const commit = await runGit(projectRoot, ["rev-parse", "HEAD"]);
  return commit || undefined;
}

/**
 * Whether the given file (relative or absolute) has uncommitted changes
 * against HEAD — a small extra signal alongside the content hash for a
 * human reading a manifest (e.g. "this checkpoint's source hash matches
 * HEAD, but there are uncommitted local edits since"). Returns undefined
 * (not false) when Git is unavailable, so callers don't confuse "clean"
 * with "unknown".
 */
export async function isFileDirty(projectRoot: string, relativeOrAbsolutePath: string): Promise<boolean | undefined> {
  const output = await runGit(projectRoot, ["status", "--porcelain", "--", relativeOrAbsolutePath]);
  if (output === undefined) return undefined;
  return output.length > 0;
}

/**
 * Files that changed between a prior commit and the current HEAD —
 * used only to narrow "which components might be affected by recent
 * source changes" (ADR 0017 §11); never a substitute for the actual
 * per-file content hash comparison the staleness check relies on.
 * Returns undefined if Git is unavailable or `sinceCommit` can't be
 * resolved (e.g. it belongs to a different repo, or history was
 * rewritten).
 */
export async function getChangedFilesSince(projectRoot: string, sinceCommit: string): Promise<string[] | undefined> {
  const output = await runGit(projectRoot, ["diff", "--name-only", sinceCommit, "HEAD"]);
  if (output === undefined) return undefined;
  return output.length > 0 ? output.split("\n").filter(Boolean) : [];
}

/**
 * `sha256:<hex>` of a file's current on-disk content — the source-state
 * fingerprint every checkpoint manifest records (ADR 0017 §8). Deliberately
 * NOT Git-based: a Git commit hash alone doesn't capture uncommitted local
 * edits, and this needs to work identically with or without Git present.
 * Throws (does not degrade to undefined) on a read failure — unlike the
 * Git helpers above, a source file that can't be read is a real error the
 * caller needs to see, not an optional enrichment that's fine to skip.
 */
export async function hashFileContent(absolutePath: string): Promise<string> {
  const bytes = await readFile(absolutePath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  return `sha256:${hash}`;
}
