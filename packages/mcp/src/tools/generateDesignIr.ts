import { resolve } from "node:path";
import type { ModelProvider } from "@reactfig/model";
import { inspectComponentSource, buildComponentEvidence, generateDesignIR, type OrchestrateResult, type RenderCapture, debugLog, type ProgressReporter } from "@reactfig/analyzer";
import {
  writeCheckpoint,
  writeDesignIrAndValidation,
  initialManifest,
  patchManifest,
  versionLabel,
  writeCaptureArtifact,
  tryReadCaptureArtifact,
  type CheckpointDir,
  type CheckpointManifestSource,
} from "../checkpoint.js";
import { upsertCheckpointMapEntry, openOrResumeVersionedCheckpointDir } from "../checkpointMap.js";
import { buildCapturePlan, type PlannedCaptureRequest } from "../capturePlan.js";
import { getCurrentGitCommit, hashFileContent } from "../git.js";

export interface ViewportSpec {
  name: string;
  width: number;
  height: number;
}

export interface VariantCaptureSpec {
  /** The prop values this capture represents — becomes evidence for variant-axis confirmation during AI interpretation, same as any other capture (see docs/adr/0008-ai-orchestration.md, "Variants"). */
  propValues: Record<string, unknown>;
  /** Defaults to the top-level `url`/`selector` if the variant renders at the same location (e.g. a Storybook-style control) rather than a different route. */
  url?: string;
  selector?: string;
  viewport?: ViewportSpec;
  /**
   * Simulate this DOM interaction before capturing — see
   * playwrightCapture.ts's applyInteractionState and docs/adr/0023-
   * interaction-state-capture.md. Combines with `propValues` (a capture
   * can be both `variant: "primary"` AND `interactionState: "hover"`);
   * omit for an ordinary default-state capture, same as today.
   */
  interactionState?: "hover" | "focus" | "active";
}

export interface GenerateDesignIrArgs {
  /**
   * Path to the .tsx source file, relative to projectRoot. Optional —
   * omit for source-less Design IR generation (docs/adr/0027): React
   * source is valuable corroborating evidence, but no longer a mandatory
   * prerequisite. When omitted, both `componentName` and
   * `sourceFingerprint` become required (see each field's own doc
   * comment) since there's no AST to derive a name from and no file to
   * hash for checkpoint-resumability purposes.
   */
  sourceFile?: string;
  exportName?: string;
  /** Defaults to the AST-detected export name. REQUIRED when `sourceFile` is omitted — source-less generation has no AST to infer a name from. */
  componentName?: string;
  /**
   * REQUIRED when `sourceFile` is omitted, ignored otherwise. A caller-
   * supplied stable hash identifying this generation's "source state" for
   * checkpoint resumability (docs/adr/0017 §8) — the same role
   * hashFileContent(sourceFile) plays for the ordinary path, just
   * supplied directly since there's no file to hash here.
   * generate_design_ir_from_capture computes this automatically (a hash
   * of the persisted capture evidence) for its own source-less calls;
   * most direct callers of generate_design_ir won't need to set this by
   * hand.
   */
  sourceFingerprint?: string;
  /** The running dev server URL where the component is rendered. */
  url: string;
  /** CSS selector for the component's root DOM node. */
  selector: string;
  /** First entry is the default capture; defaults to a single 1440x900 "desktop" viewport. */
  viewports?: ViewportSpec[];
  variants?: VariantCaptureSpec[];
  maxRepairAttempts?: number;
  maxToolIterations?: number;
  /**
   * Optional free-text guidance appended to the model's system prompt,
   * e.g. "focus on the avatar's status-dot overlay and badge styling".
   * Does not affect which DOM/CSS evidence is captured (that's
   * deterministic, driven by selector/viewports/variants) — only how the
   * model interprets it. See docs/adr/0013's addendum for why this
   * exists: a real MCP client sent a `prompt` argument the schema didn't
   * recognize; it was previously stripped silently and had no effect.
   */
  prompt?: string;
  /** Overrides the server's default project root for this call only — see packages/mcp/src/projectRoot.ts. Consumed by the server dispatch layer (src/server.ts), not read here; present on this type for documentation/schema purposes. */
  projectRoot?: string;
}

export interface CaptureRequest {
  url: string;
  selector: string;
  label: string;
  viewport: { width: number; height: number };
  viewportLabel?: string;
  propValues?: Record<string, unknown>;
  /**
   * Simulate this DOM interaction on the selected element before reading
   * computed style/DOM — see playwrightCapture.ts's interaction-driving
   * code and docs/adr/0023-interaction-state-capture.md. Absent means an
   * ordinary default-state capture, same as today.
   */
  interactionState?: "hover" | "focus" | "active";
  rootComponentName: string;
  /**
   * Only true when the configured model provider actually has
   * `capabilities.vision` — capturing a screenshot costs real wall-clock
   * time inside a request that already has a hard budget (see docs/adr/
   * 0013-generate-design-ir-timeout.md), so it's skipped entirely rather
   * than captured-and-ignored when the model can't use it.
   */
  captureScreenshot: boolean;
  /** Forwarded from the MCP request so a client cancellation stops in-flight browser/model work instead of leaving it running — see docs/adr/0013. */
  signal?: AbortSignal;
}

export interface GenerateDesignIrContext {
  projectRoot: string;
  provider: ModelProvider;
  /**
   * Performs one deterministic render capture. The production default
   * (see src/playwrightCapture.ts, wired in server.ts) launches a real
   * Playwright browser and delegates to @reactfig/analyzer's
   * captureRenderedComponent — untested in this repository's sandboxed
   * dev environment (no network access to a browser binary here), the
   * same disclosed limitation as @reactfig/analyzer's own browser layer.
   * Tests inject a fake implementation, so everything below — looping
   * over viewports/variants, building evidence, invoking AI
   * orchestration — is fully tested independent of Playwright.
   */
  captureComponent: (request: CaptureRequest) => Promise<RenderCapture>;
  /** Forwarded to captureComponent and every model call — see docs/adr/0013-generate-design-ir-timeout.md. */
  signal?: AbortSignal;
  /** Best-effort MCP progress notifications, forwarded to the AI orchestration loop — see @reactfig/analyzer's ai/progress.ts. */
  onProgress?: ProgressReporter;
  /**
   * Optional override for the checkpoint root. Defaults to
   * `<projectRoot>/.reactfig/checkpoints`. Tests point this at a temp
   * directory; production callers omit it.
   */
  checkpointRootDir?: string;
  /**
   * Optional override for the checkpoint-map.json path. Defaults to
   * `<projectRoot>/.reactfig/checkpoint-map.json`. Tests point this at a
   * temp path; production callers omit it.
   */
  checkpointMapPath?: string;
}

export interface GenerateDesignIrResult extends OrchestrateResult {
  componentName: string;
  captureCount: number;
  /**
   * Non-fatal capture-time concerns worth double-checking before trusting
   * the result — currently just selector ambiguity (see
   * captureComponent.ts's matchCount on RenderCapture): a selector that
   * matched more than one element on the page didn't fail outright
   * (Playwright/DOM APIs silently accept the first match), but the
   * element that ended up captured may not be the one you meant.
   */
  warnings: string[];
  /**
   * The version-scoped checkpoint directory this run persisted its stages
   * to (`.reactfig/checkpoints/<componentName>/v<N>/`), so a downstream
   * export_design_artifact/merge_design_ir_checkpoints call can reconstruct
   * the Design IR from disk rather than consuming this in-memory object.
   * See packages/mcp/src/checkpoint.ts.
   */
  checkpointDir: string;
  /** The version number this generation was persisted as (1-based; a component's Nth-ever successful generate_design_ir call gets version N). */
  checkpointVersion: number;
  /** `"<componentName>@v<checkpointVersion>"` — a ready-to-use reference for merge_design_ir_checkpoints/diff_design_ir, e.g. `"SessionCard@v2"`. */
  checkpointRef: string;
}

const DEFAULT_VIEWPORT: ViewportSpec = { name: "desktop", width: 1440, height: 900 };

/**
 * The primary "expose AI analysis" tool: capture (browser) + inspect
 * (AST) + evidence assembly + AI orchestration, in one call. This is pure
 * composition — every step delegates to an existing @reactfig/analyzer
 * function; nothing here reimplements analyzer/AI/IR-construction logic.
 * A client only supplies where the component lives (source file, running
 * URL, selector) and, optionally, which additional viewports/prop
 * combinations to capture — it never needs to call get_evidence-style
 * low-level steps itself.
 */
export async function generateDesignIrTool(args: GenerateDesignIrArgs, ctx: GenerateDesignIrContext): Promise<GenerateDesignIrResult> {
  // Source-less path (docs/adr/0027, "Source-less Design IR Generation"):
  // no AST to inspect, so a synthetic ComponentSourceEvidence stands in —
  // `jsx: null` / `importedComponents: []` already read, correctly, as
  // "no source-derived structural corroboration available" to every
  // downstream consumer (buildComponentEvidence, the AI interpretation
  // prompt, etc.) without any of them needing a new code path of their
  // own. The evidence is marked capture-inferred in `meta.limitations`
  // below, right after buildComponentEvidence assembles it, so nothing
  // downstream can mistake an inferred structure for one React source
  // actually declared (docs section 15).
  const sourceless = args.sourceFile === undefined;
  let absolutePath: string | undefined;
  let source: import("@reactfig/analyzer").ComponentSourceEvidence;
  let componentName: string;
  let contentHash: string;
  let gitCommit: string | undefined;
  let manifestSource: CheckpointManifestSource;

  if (sourceless) {
    if (!args.componentName) {
      throw new Error(
        "generate_design_ir: `componentName` is required when `sourceFile` is omitted — source-less generation has no AST to infer an export name from."
      );
    }
    if (!args.sourceFingerprint) {
      throw new Error(
        "generate_design_ir: `sourceFingerprint` is required when `sourceFile` is omitted — a stable hash identifying this capture's evidence state, so checkpoint resumability still works without a source file. generate_design_ir_from_capture computes this automatically."
      );
    }
    componentName = args.componentName;
    source = { file: "", exportName: componentName, props: [], jsx: null, importedComponents: [], usesPortal: false };
    contentHash = args.sourceFingerprint;
    gitCommit = undefined;
    manifestSource = { file: `capture:${componentName}`, contentHash, gitCommit };
    debugLog("source-less generation — skipping AST inspection", { componentName });
  } else {
    debugLog("source inspection started", { sourceFile: args.sourceFile });
    absolutePath = resolve(ctx.projectRoot, args.sourceFile!);
    source = inspectComponentSource(absolutePath, { exportName: args.exportName });
    componentName = args.componentName ?? source.exportName;
    debugLog("source inspection finished", { componentName });
    [contentHash, gitCommit] = await Promise.all([hashFileContent(absolutePath), getCurrentGitCommit(ctx.projectRoot)]);
    manifestSource = { file: args.sourceFile!, contentHash, gitCommit };
  }

  const viewports = args.viewports && args.viewports.length > 0 ? args.viewports : [DEFAULT_VIEWPORT];
  const warnings: string[] = [];
  // Screenshots cost real wall-clock time inside a request with a hard
  // budget (docs/adr/0013) — only ever requested when the configured model
  // can actually use one. Fixes a real gap: previously no capture request
  // set this at all, so a screenshot was never taken and REACTFIG_MODEL_
  // VISION=true had no observable effect on the evidence the model saw.
  const captureScreenshot = ctx.provider.capabilities.vision;

  function warnIfAmbiguous(capture: RenderCapture, selector: string): void {
    // matchCount > 1 doesn't fail the capture outright — page.locator(...)
    // and document.querySelector both silently accept the first DOM match
    // for a selector, and that first match might well be the right one —
    // but it's exactly the kind of thing that otherwise only turns up as
    // "the exported component looks subtly wrong" after the pipeline's
    // expensive stages have already run, so it's surfaced here instead.
    if (capture.matchCount && capture.matchCount > 1) {
      warnings.push(
        `capture "${capture.label}": selector "${selector}" matched ${capture.matchCount} elements on the page — captured the first one, which may not be "${componentName}"'s own instance if the selector isn't specific enough.`
      );
    }
  }

  // Build the full list of requested captures — same default-viewport +
  // extra-viewports + variants shape as before — but don't actually
  // capture anything yet: a capture plan (capturePlan.ts) needs the
  // *identity* of every requested capture up front so its deterministic
  // ids/revisionKey can be computed before allocating (or resuming) a
  // checkpoint version.
  const requests: PlannedCaptureRequest[] = viewports.map((viewport, index) => ({
    label: index === 0 ? "default" : `viewport=${viewport.name}`,
    url: args.url,
    selector: args.selector,
    viewport: { width: viewport.width, height: viewport.height },
    viewportLabel: viewport.name,
  }));
  for (const variant of args.variants ?? []) {
    const viewport = variant.viewport ?? viewports[0];
    const label = `variant=${Object.entries(variant.propValues)
      .map(([k, v]) => `${k}:${String(v)}`)
      .join(",")}`;
    requests.push({
      label: variant.interactionState ? `${label},state:${variant.interactionState}` : label,
      url: variant.url ?? args.url,
      selector: variant.selector ?? args.selector,
      viewport: { width: viewport.width, height: viewport.height },
      viewportLabel: viewport.name,
      propValues: variant.propValues,
      interactionState: variant.interactionState,
    });
  }

  // Source-state fingerprint (ADR 0017 §8) was already computed above —
  // content hash of the source file (or, source-less, the caller-supplied
  // sourceFingerprint) either way; a capture plan's revisionKey is keyed
  // on it, so resuming an interrupted run only ever matches a checkpoint
  // whose source hadn't changed since.
  const freshPlan = buildCapturePlan(contentHash, requests);

  // Resumable capture (see capturePlan.ts, checkpointMap.ts's
  // openOrResumeVersionedCheckpointDir): reuses the latest existing
  // checkpoint version instead of allocating a new one only when it's for
  // this exact source state and exact requested capture set, and its
  // capture stage never finished — otherwise this is a fresh generation
  // and gets its own version, same as always (ADR 0017 §2).
  const { dir: checkpoint, resumed, plan: activePlan, manifest: existingManifest } = await openOrResumeVersionedCheckpointDir(
    ctx.projectRoot,
    componentName,
    freshPlan,
    { rootDir: ctx.checkpointRootDir, mapPath: ctx.checkpointMapPath }
  );
  debugLog(resumed ? "resuming checkpoint" : "starting fresh checkpoint", { component: componentName, version: checkpoint.version, resumed });

  let manifest = existingManifest ?? initialManifest(componentName, manifestSource);
  if (!existingManifest) await writeCheckpoint(checkpoint, "manifest", manifest);
  manifest = await patchManifest(checkpoint, { stages: { sourceInspection: "completed", capture: "in_progress" } }, manifest);
  await writeCheckpoint(checkpoint, "capturePlan", activePlan);

  const renderCaptures: RenderCapture[] = [];
  let captureIndex = 0;
  for (const entry of activePlan.captures) {
    captureIndex += 1;
    if (entry.status === "completed") {
      const persisted = await tryReadCaptureArtifact<RenderCapture>(checkpoint, entry.id);
      if (persisted) {
        renderCaptures.push(persisted);
        warnIfAmbiguous(persisted, entry.selector);
        continue;
      }
      // Marked completed but the artifact is missing (shouldn't happen —
      // defensive only, e.g. a hand-edited checkpoint) — fall through and
      // recapture it rather than silently proceeding with a hole in the
      // evidence set.
    }

    ctx.onProgress?.(`capturing ${captureIndex}/${activePlan.captures.length} (${entry.label})`);
    let capture: RenderCapture;
    try {
      capture = await ctx.captureComponent({
        url: entry.url,
        selector: entry.selector,
        label: entry.label,
        viewport: entry.viewport,
        viewportLabel: entry.viewportLabel,
        propValues: entry.propValues,
        interactionState: entry.interactionState,
        rootComponentName: componentName,
        captureScreenshot,
        signal: ctx.signal,
      });
    } catch (err) {
      entry.status = "failed";
      entry.error = err instanceof Error ? err.message : String(err);
      await writeCheckpoint(checkpoint, "capturePlan", activePlan);
      manifest = await patchManifest(checkpoint, { stages: { capture: "failed" } }, manifest);
      // The checkpoint map must know this version exists even though the
      // run failed — otherwise a later call's fast map-check (see
      // openOrResumeVersionedCheckpointDir) finds no entry at all and
      // allocates a brand new version instead of resuming this one, and
      // every capture completed so far (durably persisted above) would
      // never be reused.
      await upsertCheckpointMapEntry(ctx.projectRoot, manifest, checkpoint, { mapPath: ctx.checkpointMapPath });
      // Re-thrown, not swallowed — every previously-completed capture in
      // this plan (this run's and any resumed from before) is already
      // durably persisted, so the next call for the same component/source/
      // requested captures resumes from exactly this point instead of
      // recapturing everything.
      throw err;
    }

    warnIfAmbiguous(capture, entry.selector);
    await writeCaptureArtifact(checkpoint, entry.id, capture);
    entry.status = "completed";
    entry.error = undefined;
    await writeCheckpoint(checkpoint, "capturePlan", activePlan);
    renderCaptures.push(capture);
  }

  manifest = await patchManifest(checkpoint, { stages: { capture: "completed" }, artifacts: { capturePlan: "capture-plan.json" } }, manifest);

  debugLog("evidence assembly started", { captureCount: renderCaptures.length });
  ctx.onProgress?.("assembling evidence");
  const evidence = buildComponentEvidence({
    componentName,
    source,
    captures: renderCaptures,
    analyzerVersion: "@reactfig/mcp@0.1.0",
   });
  if (sourceless) {
    // Provenance (docs section 15): this evidence's `source` is a
    // placeholder, not a real inspection — nothing in it (props, jsx,
    // importedComponents) came from an actual React file. Recorded here,
    // on the assembled evidence's own existing `meta.limitations` list
    // (see buildComponentEvidence.ts) rather than a new field, so every
    // consumer that already reads limitations (AI interpretation prompt,
    // checkpoint manifest, a human reviewing evidence.json) sees this the
    // same way it sees any other known evidence gap — no separate
    // provenance framework needed for v1 (docs section 15).
    evidence.meta.limitations.push(
      `Source-less generation: no React source file was available for "${componentName}" — this Design IR was interpreted purely from captured DOM structure, computed styles, layout geometry, and a screenshot (docs/adr/0027). Component/prop names and structure are AI-inferred from the capture, not read from source; do not treat them as though React source declared them.`
    );
  }
  debugLog("evidence assembly finished");

   // Persist the assembled evidence (all captures combined) before any
   // model work — a later-stage failure leaves this on disk for debugging
   // without re-running capture (PROMPT.md §6). Individual per-capture
   // artifacts (captures/<id>.json) were already persisted incrementally
   // above as each one completed; this is the combined view the model
   // actually reasons over.
  debugLog("checkpoint: persisting evidence", { path: checkpoint.path });
  await writeCheckpoint(checkpoint, "evidence", evidence);
  manifest = await patchManifest(checkpoint, { artifacts: { evidence: "evidence.json" } }, manifest);

  const result = await generateDesignIR(ctx.provider, evidence, {
    maxRepairAttempts: args.maxRepairAttempts,
    maxToolIterations: args.maxToolIterations,
    guidance: args.prompt,
    signal: ctx.signal,
    onProgress: ctx.onProgress,
   });

   // Persist the model interpretation, then the constructed Design IR plus
   // its validation diagnostics, using the checkpoint helpers so the
   // validate-then-persist ordering is enforced in one place. The manifest
   // is patched — never rewritten wholesale — after each stage actually
   // succeeds, so a crash mid-pipeline leaves the manifest honestly
   // reflecting only what completed (ADR 0017 §20: never mark a stage
   // completed before its artifact is durably written).
  debugLog("checkpoint: persisting interpretation", { path: checkpoint.path });
  await writeCheckpoint(checkpoint, "interpretation", result.interpretation);
  manifest = await patchManifest(checkpoint, { stages: { interpretation: "completed" }, artifacts: { interpretation: "interpretation.json" } }, manifest);

  debugLog("checkpoint: persisting design IR + validation", { path: checkpoint.path });
  const { validation } = await writeDesignIrAndValidation(checkpoint, result.document);
  manifest = await patchManifest(
    checkpoint,
    {
      stages: { designIr: "completed", validation: "completed" },
      artifacts: { designIr: "design-ir.json", validation: "validation.json" },
      validation: { valid: validation.valid, errorCount: validation.errors.length },
    },
    manifest
  );

  await upsertCheckpointMapEntry(ctx.projectRoot, manifest, checkpoint, { mapPath: ctx.checkpointMapPath });

  return {
    ...result,
    componentName,
    captureCount: renderCaptures.length,
    warnings,
    checkpointDir: checkpoint.path,
    checkpointVersion: checkpoint.version,
    checkpointRef: `${checkpoint.id}@${versionLabel(checkpoint.version)}`,
  };
}