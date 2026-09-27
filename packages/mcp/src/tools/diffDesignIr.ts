import { diffDesignDocuments, formatDesignIrDiff, type DesignDocument, type DesignIrDiffResult } from "@reactfig/core";
import { resolveCheckpointRef, readValidatedDesignIr, versionLabel, type CheckpointDir } from "../checkpoint.js";

export interface DiffDesignIrArgs {
  /** Inline "before" document. Mutually exclusive with beforeCheckpoint — exactly one of the two must be given. */
  before?: DesignDocument;
  /** Inline "after" document. Mutually exclusive with afterCheckpoint — exactly one of the two must be given. */
  after?: DesignDocument;
  /** Checkpoint reference for the "before" document: a component name (latest version), "Name@latest", or "Name@vN". */
  beforeCheckpoint?: string;
  /** Checkpoint reference for the "after" document. */
  afterCheckpoint?: string;
  /** Optional title used only in the rendered `report` string. Defaults to a description built from whichever checkpoint refs/component names were given. */
  title?: string;
}

export interface DiffDesignIrContext {
  projectRoot: string;
}

export interface DiffDesignIrResult extends DesignIrDiffResult {
  /** Human-readable, category-grouped rendering of `entries` — see @reactfig/core's formatDesignIrDiff. Structured `entries`/`summary` are still the form to consume programmatically; this is for display. */
  report: string;
  /** Present only when the corresponding side was given as a checkpoint reference — the checkpoint it actually resolved to, since "ComponentName" alone resolves to "whatever the latest version happens to be right now". */
  resolvedBefore?: { checkpointRef: string; path: string };
  resolvedAfter?: { checkpointRef: string; path: string };
}

/**
 * Compares two design-ir/v1 documents and reports every semantically
 * meaningful difference (`@reactfig/core`'s `diffDesignDocuments` — see
 * that module for why this is a structural, id-matched comparison and
 * not a generic JSON diff).
 *
 * Each side can be given either as an inline document (for comparing a
 * document a client already has in hand, e.g. before vs. after a manual
 * edit) or as a checkpoint reference (`beforeCheckpoint`/`afterCheckpoint`
 * — a component name, `"Name@latest"`, or `"Name@vN"`), which is resolved
 * and read straight from `.reactfig/checkpoints/` the same way
 * merge_design_ir_checkpoints resolves its inputs. This is what makes
 * `SessionCard@v1` vs `SessionCard@v2` a single tool call rather than
 * requiring the caller to read and paste two potentially large documents
 * (ADR 0017 §18).
 */
export async function diffDesignIrTool(args: DiffDesignIrArgs, ctx: DiffDesignIrContext): Promise<DiffDesignIrResult> {
  if ((args.before !== undefined) === (args.beforeCheckpoint !== undefined)) {
    throw new Error('diff_design_ir: give exactly one of `before` (an inline document) or `beforeCheckpoint` (a checkpoint reference), not both or neither.');
  }
  if ((args.after !== undefined) === (args.afterCheckpoint !== undefined)) {
    throw new Error('diff_design_ir: give exactly one of `after` (an inline document) or `afterCheckpoint` (a checkpoint reference), not both or neither.');
  }

  let before: DesignDocument;
  let beforeDir: CheckpointDir | undefined;
  if (args.beforeCheckpoint) {
    beforeDir = await resolveCheckpointRef(ctx.projectRoot, args.beforeCheckpoint);
    before = await readValidatedDesignIr(beforeDir);
  } else {
    before = args.before!;
  }

  let after: DesignDocument;
  let afterDir: CheckpointDir | undefined;
  if (args.afterCheckpoint) {
    afterDir = await resolveCheckpointRef(ctx.projectRoot, args.afterCheckpoint);
    after = await readValidatedDesignIr(afterDir);
  } else {
    after = args.after!;
  }

  const result = diffDesignDocuments(before, after);

  const title =
    args.title ??
    `${beforeDir ? `${beforeDir.id}@${versionLabel(beforeDir.version)}` : before.name} \u2192 ${afterDir ? `${afterDir.id}@${versionLabel(afterDir.version)}` : after.name}`;
  const report = formatDesignIrDiff(result, title);

  return {
    ...result,
    report,
    resolvedBefore: beforeDir ? { checkpointRef: `${beforeDir.id}@${versionLabel(beforeDir.version)}`, path: beforeDir.path } : undefined,
    resolvedAfter: afterDir ? { checkpointRef: `${afterDir.id}@${versionLabel(afterDir.version)}`, path: afterDir.path } : undefined,
  };
}
