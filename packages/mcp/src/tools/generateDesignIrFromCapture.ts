import { join } from "node:path";
import type { ModelProvider } from "@reactfig/model";
import type { ProgressReporter } from "@reactfig/analyzer";
import { CollectionSession } from "../collection/collectionSession.js";
import { createCollectionCapture } from "../collection/collectionCapture.js";
import { CollectionStateError } from "../collection/collectionManifest.js";
import { resolveOutputFormat, type OutputFormat } from "../collection/types.js";
import { hashFileContent } from "../git.js";
import { generateDesignIrTool, type GenerateDesignIrResult } from "./generateDesignIr.js";

export interface GenerateDesignIrFromCaptureArgs {
  collectionId: string;
  selectionId: string;
  /**
   * Path to the .tsx source file, relative to projectRoot. Optional —
   * omit for source-less generation (docs/adr/0027): the selection's own
   * persisted capture evidence (DOM/CSS/screenshot) is used instead, no
   * React source required. When omitted, `componentName` is used if
   * given, else falls back to the selection's own recorded
   * componentPath (its innermost/last entry) — see resolveComponentName.
   */
  sourceFile?: string;
  exportName?: string;
  componentName?: string;
  prompt?: string;
  maxRepairAttempts?: number;
  maxToolIterations?: number;
  projectRoot?: string;
}

export interface GenerateDesignIrFromCaptureContext {
  projectRoot: string;
  provider: ModelProvider;
  signal?: AbortSignal;
  onProgress?: ProgressReporter;
  checkpointRootDir?: string;
  checkpointMapPath?: string;
  collectionsRootDir?: string;
}

export interface GenerateDesignIrFromCaptureResult extends GenerateDesignIrResult {
  /**
   * Output Intent (docs/architecture.md), resolved from this selection's
   * OWN persisted Interactive Capture data — selection-level override,
   * else the collection's default, else "rfd" — see
   * collection/types.ts's resolveOutputFormat. Never recovered from the
   * OpenCode/Claude prompt (docs section 4): pass this straight through
   * to export_design_output's `format` to honor what the developer
   * actually picked in the overlay, without the agent needing to ask
   * again or guess.
   */
  outputFormat: OutputFormat;
}

/** `["Dashboard", "SessionCard", "StatCard"]` -> `"StatCard"` — the innermost/most-specific name, same convention generate_design_ir's own `componentName ?? source.exportName` fallback follows for the sourced path. */
function componentNameFromPath(componentPath: string[] | null, tag: string): string {
  if (componentPath && componentPath.length > 0) return componentPath[componentPath.length - 1];
  return tag;
}

/**
 * Runs the existing, unmodified generate_design_ir pipeline against one
 * finalized Interactive Capture selection instead of a live
 * url/selector — the entire integration between Interactive Capture and
 * the rest of ReactFig. Everything after evidence acquisition (source
 * inspection, AI interpretation, Design IR construction, checkpointing,
 * merge, export) is the exact same code path a normal generate_design_ir
 * call runs; this only swaps in an alternate `captureComponent` (see
 * collection/collectionCapture.ts) that reads persisted evidence off disk
 * instead of driving a live Playwright page, and derives `url`/`selector`
 * from the selection's own recorded metadata instead of taking them as
 * arguments. generate_design_ir itself is completely untouched — see
 * docs/architecture.md, "Collection → existing pipeline": no mode-
 * switching, no second pipeline.
 *
 * `sourceFile` is optional here too (docs/adr/0027): when omitted, this
 * is a fully source-less generation — no React source is inspected at
 * all, and generate_design_ir's `sourceFingerprint` requirement is
 * satisfied automatically by hashing the selection's own persisted
 * evidence.json (the capture IS the "source" being fingerprinted, in
 * exactly the role a .tsx file's content hash plays for the ordinary
 * path — see generateDesignIr.ts's own doc comment on `sourceFingerprint`).
 */
export async function generateDesignIrFromCaptureTool(args: GenerateDesignIrFromCaptureArgs, ctx: GenerateDesignIrFromCaptureContext): Promise<GenerateDesignIrFromCaptureResult> {
  const session = await CollectionSession.resume({ projectRoot: ctx.projectRoot, collectionId: args.collectionId, collectionsRootDir: ctx.collectionsRootDir });
  const manifest = session.getManifest();

  if (manifest.status !== "completed") {
    throw new CollectionStateError(
      `Collection "${args.collectionId}" is not finalized yet (status: "${manifest.status}"). Call finalize_interactive_capture first — generate_design_ir_from_capture only consumes a completed collection, so the browser is never a hidden dependency of the pipeline stages that follow it.`
    );
  }

  const selection = manifest.selections.find((s) => s.selectionId === args.selectionId);
  if (!selection) {
    throw new CollectionStateError(`Collection "${args.collectionId}" has no selection "${args.selectionId}".`);
  }
  if (selection.status === "removed") {
    throw new CollectionStateError(`Selection "${args.selectionId}" was removed from collection "${args.collectionId}" before finalization and is not usable as pipeline input.`);
  }
  if (selection.status === "failed") {
    throw new CollectionStateError(`Selection "${args.selectionId}" failed to capture (${selection.error ?? "unknown error"}) and has no usable evidence.`);
  }

  const captureComponent = createCollectionCapture(selection, session.dir);
  const outputFormat = resolveOutputFormat(manifest, args.selectionId);

  const sourceless = args.sourceFile === undefined;
  const sourcelessFields = sourceless
    ? {
        componentName: args.componentName ?? componentNameFromPath(selection.componentPath, selection.tag),
        // The persisted evidence for this selection IS this generation's
        // "source state" when there's no file to hash — same hashing
        // function (git.ts's hashFileContent), just pointed at
        // evidence.json instead of a .tsx file (see this function's own
        // doc comment above).
        sourceFingerprint: await hashFileContent(join(session.dir, selection.evidencePath)),
      }
    : {};

  const result = await generateDesignIrTool(
    {
      sourceFile: args.sourceFile,
      exportName: args.exportName,
      componentName: args.componentName,
      url: selection.url,
      selector: selection.selector,
      prompt: args.prompt,
      maxRepairAttempts: args.maxRepairAttempts,
      maxToolIterations: args.maxToolIterations,
      ...sourcelessFields,
    },
    {
      projectRoot: ctx.projectRoot,
      provider: ctx.provider,
      captureComponent,
      signal: ctx.signal,
      onProgress: ctx.onProgress,
      checkpointRootDir: ctx.checkpointRootDir,
      checkpointMapPath: ctx.checkpointMapPath,
    }
  );

  return { ...result, outputFormat };
}
