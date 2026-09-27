import { createHash } from "node:crypto";
import {
  mergeDesignDocuments,
  buildInstanceOverridesFromPerInstanceData,
  applyVariantAssignments,
  stableStringify,
  type DesignDocument,
  type MergeDesignDocumentsResult,
  type InstanceOverridesInput,
  type PerInstanceDataItem,
} from "@reactfig/core";
import {
  resolveCheckpointRef,
  openVersionedCheckpointDir,
  readValidatedDesignIr,
  writeDesignIrAndValidation,
  initialManifest,
  patchManifest,
  versionLabel,
  findDivergentSiblingVersions,
  type CheckpointDir,
  type CheckpointManifestSource,
} from "../checkpoint.js";
import { upsertCheckpointMapEntry } from "../checkpointMap.js";
import { getCurrentGitCommit } from "../git.js";
import { exportDesignArtifactTool, type ExportDesignArtifactResult } from "./exportDesignArtifact.js";

export interface MergeDesignIrCheckpointsArgs {
  /** Checkpoint reference for the outer/composite component — a component name (resolves its latest version), `"Name@latest"`, or `"Name@vN"` for a specific version, e.g. the `checkpointRef` generate_design_ir returned for SessionCard. */
  primaryCheckpointId: string;
  /** Checkpoint references for the nested components the primary references, same reference syntax as primaryCheckpointId — e.g. Avatar/Badge/Button's checkpoints. */
  dependencyCheckpointIds: string[];
  /** Checkpoint id to persist the merged document under. Defaults to `merged-<primary component name>`. */
  mergedCheckpointId?: string;
  /** Package the merged document into a .rfd artifact in the same call. Default true. */
  exportArtifact?: boolean;
  /** Where to write the .rfd file when exportArtifact is true — relative to projectRoot, or absolute. Defaults to "design/<document name>.rfd". */
  outputPath?: string;
  /** Attempt to fetch http(s) asset references automatically before packing, when exportArtifact is true. Default true. */
  fetchAssets?: boolean;
  /**
   * After merging the explicitly supplied primary + dependencyCheckpointIds,
   * try to resolve any remaining `unresolvedExternalRefs` (ADR 0008) against
   * checkpoints that already exist on disk under `.reactfig/checkpoints/`
   * (e.g. from an earlier generate_design_ir run for that component name),
   * and fold them in automatically. Repeats until a pass finds nothing new
   * to add, so a resolved dependency's own further external refs (e.g.
   * SessionCard -> Avatar -> further nesting) are picked up too, not just
   * one level. Only ever *adds* dependencies already sitting on disk — never
   * generates anything — so a ref with no matching checkpoint (e.g.
   * external:StatCard when StatCard was never generated) is still reported
   * in `unresolvedExternalRefs` as before. Default true.
   */
  reuseExistingCheckpoints?: boolean;
  /**
   * Per-instance content overrides keyed by the target instance node's id
   * in the *primary* checkpoint's document — e.g. the id of one of three
   * `.map()`-rendered StatCard instances on a Dashboard. Fixes the
   * "every instance of a template component renders identical content"
   * failure mode (Issue.md Fix 2c): the merged document otherwise has no
   * way to say "same component, different data" for repeated instances.
   * See @reactfig/core's `InstanceOverride`/`findNodePath` for how to
   * build a `path` without hand-counting child indices.
   */
  instanceOverrides?: InstanceOverridesInput;
  /**
   * The natural, un-translated shape `inspect_component_dependency_tree`'s
   * `mappedDataRefs` (and `Run.md` step 2's `perInstanceData`) already
   * produce — e.g. `{ StatCard: [{label:"Sessions this week", value:"12",
   * tone:"neutral"}, {label:"Avg. speaking score", value:"6.8",
   * tone:"success"}, ...] }` — one array entry per rendered instance, in
   * the same order the instances appear in the primary document. Preferred
   * over hand-building `instanceOverrides`: this tool resolves each
   * component's own text-node paths and matches instances to items
   * automatically (see `@reactfig/core`'s
   * `buildInstanceOverridesFromPerInstanceData`), removing the step where
   * a caller has to get `InstanceOverride`'s `{path, characters}` shape
   * right by hand — the exact translation a real run previously got wrong
   * (passed plain field objects where an array of overrides was expected,
   * silently producing no overrides at all). Any explicit
   * `instanceOverrides` for the same instance are applied on top of, not
   * instead of, what this derives. Non-fatal problems deriving overrides
   * (a componentTag with no match, an item count mismatch, a field with no
   * matching captured text) are returned in `instanceOverrideWarnings`
   * rather than failing the merge.
   */
  perInstanceData?: Record<string, PerInstanceDataItem[]>;
}

export interface MergeDesignIrCheckpointsContext {
  projectRoot: string;
  /** Injectable for tests; defaults to the global fetch. Only used when exportArtifact is true. */
  fetchImpl?: typeof fetch;
  /** Injectable for deterministic manifest timestamps in tests. */
  now?: () => string;
  /** Optional override for the checkpoint-map.json path. Defaults to `<projectRoot>/.reactfig/checkpoint-map.json`. Tests point this at a temp path. */
  checkpointMapPath?: string;
}

export interface MergeDesignIrCheckpointsResult {
  mergedCheckpoint: { id: string; path: string; version: number; checkpointRef: string; designIrPath: string };
  /** See MergeDesignDocumentsResult — external:<Name> refs that no supplied *or* auto-discovered dependency resolved (e.g. the component was never generated at all). */
  unresolvedExternalRefs: string[];
  /** See MergeDesignDocumentsResult — component ids that appeared in more than one input checkpoint. */
  duplicateComponentIds: string[];
  /** Checkpoint refs (e.g. "Avatar@v001") that reuseExistingCheckpoints found on disk and folded in automatically, beyond what was explicitly passed in dependencyCheckpointIds. Empty when reuseExistingCheckpoints was false or found nothing to add. */
  autoResolvedCheckpoints: string[];
  /**
   * Non-fatal problems hit while deriving `instanceOverrides` from
   * `perInstanceData` (see that arg's doc comment) — empty when
   * `perInstanceData` wasn't supplied, or everything resolved cleanly. A
   * non-empty list here means at least one component's overrides are
   * partial or missing; check it rather than assuming a supplied
   * `perInstanceData` was fully applied just because the merge succeeded.
   */
  instanceOverrideWarnings: string[];
  /**
   * Flags a real, previously-shipped failure mode (see
   * findDivergentSiblingVersions in checkpoint.ts and
   * docs/adr/0024-divergent-checkpoint-version-detection.md): a component
   * resolved to a single (non-variant) checkpoint version while ANOTHER
   * version of that same component exists on disk, captured against a
   * different selector — the structural signature of "this component's
   * variants/instances were captured as separate generate_design_ir calls
   * instead of one call with a `variants` argument." When this is
   * non-empty, every instance of the named component in this merge is
   * rendering the SAME single captured state (text, images, and anything
   * else not covered by the nested-instance-boundary override mechanism —
   * see docs/adr/0020) regardless of `perInstanceData`, because the other
   * variants' evidence was never available to merge in the first place.
   * Recapture the named component with a single generate_design_ir call
   * using its `variants` argument to fix this, then re-run this merge.
   */
  staleCheckpointVersionWarnings: string[];
  /** Null when exportArtifact was false — the merged checkpoint was written but nothing was packaged. */
  artifact: ExportDesignArtifactResult | null;
}

/**
 * Checkpoint-native counterpart to merge_design_ir_documents.
 *
 * merge_design_ir_documents requires the caller to hold every input
 * document in memory and pass it inline as tool-call JSON — fine for one
 * dependency, expensive and easy to get wrong (truncated, re-serialized,
 * or hand-edited) once a primary has several nested dependencies. This
 * tool instead reads the primary and each dependency straight from their
 * existing checkpoints (the ones `generate_design_ir` already wrote), so
 * the client only ever threads small checkpoint references through the
 * pipeline, never full documents. Each reference resolves to a specific
 * version (ADR 0017): a bare component name or `"Name@latest"` picks up
 * that component's most recent generate_design_ir run, or `"Name@vN"`
 * pins an exact historical version — e.g. to re-merge against an Avatar
 * checkpoint from before a recent redesign.
 *
 * It then:
 *  1. Merges them with the same `@reactfig/core` `mergeDesignDocuments`
 *     `merge_design_ir_documents` uses — identical resolution semantics,
 *     just a different input path.
 *  1a. Unless `reuseExistingCheckpoints` is explicitly false, resolves any
 *     remaining `unresolvedExternalRefs` against checkpoints that already
 *     exist on disk (component name match against `.reactfig/checkpoints/`)
 *     and re-merges with those folded in, repeating until a pass adds
 *     nothing new. This is what lets a later `merge_design_ir_checkpoints`
 *     call for a composite (e.g. Dashboard) automatically pick up
 *     components generated in an earlier, unrelated pass (e.g. SessionCard,
 *     Avatar) without the caller having to already know and re-list every
 *     transitively-nested dependency by hand — see docs/adr and Issue.md
 *     for the gap this closes. It still never *generates* anything: a ref
 *     with no matching on-disk checkpoint stays in `unresolvedExternalRefs`.
 *  2. Persists the merged document as its own versioned checkpoint
 *     (`.reactfig/checkpoints/merged-<primary>/v<N>/`), with a manifest
 *     recording exactly which resolved checkpoint refs (component@vN)
 *     went into it as its "source", and updates checkpoint-map.json —
 *     so the merge step is inspectable and resumable exactly like every
 *     other pipeline stage, and a later diff_design_ir call can address
 *     it the same way as any generate_design_ir checkpoint.
 *  3. Unless `exportArtifact` is explicitly false, packages that
 *     checkpoint-reconstructed document straight into a `.rfd` artifact via
 *     `exportDesignArtifactTool` — in-process, not a second MCP round trip —
 *     so one call takes a set of component checkpoints all the way to a
 *     final artifact on disk, whether the job is a single component or a
 *     deeply nested merge, with no external script, shell, or additional
 *     model/tool-calling loop required to glue the steps together.
 */
export async function mergeDesignIrCheckpointsTool(
  args: MergeDesignIrCheckpointsArgs,
  ctx: MergeDesignIrCheckpointsContext
): Promise<MergeDesignIrCheckpointsResult> {
  const willAutoDiscover = args.reuseExistingCheckpoints ?? true;
  if (args.dependencyCheckpointIds.length === 0 && !willAutoDiscover) {
    throw new Error(
      "merge_design_ir_checkpoints: `dependencyCheckpointIds` is empty and reuseExistingCheckpoints is false — pass at least one checkpoint reference, or leave reuseExistingCheckpoints enabled to auto-discover dependencies from existing checkpoints. " +
        "If there's nothing to merge, export the primary's checkpoint directly instead."
    );
  }

  const primaryDir = await resolveCheckpointRef(ctx.projectRoot, args.primaryCheckpointId);
  const primary = await readValidatedDesignIr(primaryDir);

  const dependencyDirs: CheckpointDir[] = [];
  const dependencies: DesignDocument[] = [];
  for (const ref of args.dependencyCheckpointIds) {
    const dir = await resolveCheckpointRef(ctx.projectRoot, ref);
    dependencyDirs.push(dir);
    dependencies.push(await readValidatedDesignIr(dir));
  }

  let mergeResult: MergeDesignDocumentsResult = mergeDesignDocuments(primary, dependencies, args.instanceOverrides);

  const autoResolvedCheckpoints: string[] = [];
  if (args.reuseExistingCheckpoints ?? true) {
    // usedIds tracks every component name already folded in (primary +
    // explicit deps + anything auto-resolved so far) so we never re-add the
    // same checkpoint twice and never loop forever re-discovering the same
    // unresolved name. Bounded by MAX_PASSES rather than "until no unresolved
    // refs remain" because a ref with no matching on-disk checkpoint at all
    // (e.g. external:StatCard, never generated) would otherwise never shrink
    // the unresolved set and the loop would spin until the pass genuinely
    // finds nothing new — which is the actual termination condition below.
    const usedIds = new Set<string>([primaryDir.id, ...dependencyDirs.map((d) => d.id)]);
    const MAX_PASSES = 10;
    for (let pass = 0; pass < MAX_PASSES && mergeResult.unresolvedExternalRefs.length > 0; pass++) {
      const found: CheckpointDir[] = [];
      for (const ref of mergeResult.unresolvedExternalRefs) {
        const match = /^external:(.+)$/.exec(ref);
        if (!match) continue;
        const candidateName = match[1];
        if (usedIds.has(candidateName)) continue;
        let dir: CheckpointDir;
        try {
          dir = await resolveCheckpointRef(ctx.projectRoot, candidateName);
        } catch {
          continue; // no checkpoint on disk for this name — stays unresolved, reported as before
        }
        if (usedIds.has(dir.id)) continue;
        usedIds.add(dir.id);
        usedIds.add(candidateName);
        found.push(dir);
      }
      if (found.length === 0) break; // nothing new this pass — remaining refs genuinely have no on-disk checkpoint

      for (const dir of found) {
        dependencyDirs.push(dir);
        dependencies.push(await readValidatedDesignIr(dir));
        autoResolvedCheckpoints.push(`${dir.id}@${versionLabel(dir.version)}`);
      }
      mergeResult = mergeDesignDocuments(primary, dependencies, args.instanceOverrides);
    }
  }

  // See findDivergentSiblingVersions's doc comment (checkpoint.ts) and
  // docs/adr/0024-divergent-checkpoint-version-detection.md: checked for
  // every resolved checkpoint (primary + every dependency, explicit or
  // auto-discovered), since the failure mode this catches — a component
  // captured as separate per-instance generate_design_ir calls instead of
  // one `variants` call — can happen to any of them, not just the ones
  // with a lot of on-page instances.
  const staleCheckpointVersionWarnings: string[] = [];
  for (const dir of [primaryDir, ...dependencyDirs]) {
    const siblings = await findDivergentSiblingVersions(ctx.projectRoot, dir.id, dir.version);
    if (siblings.length === 0) continue;
    const siblingList = siblings.map((s) => `v${s.version} (selector: ${s.selectors.join(", ")})`).join("; ");
    staleCheckpointVersionWarnings.push(
      `"${dir.id}" resolved to ${dir.id}@v${dir.version} — a single, non-variant checkpoint — but ${siblings.length} other version(s) with a DIFFERENT capture selector also exist on disk and were NOT included: ${siblingList}. ` +
        `This is the signature of capturing "${dir.id}"'s different instances/variants as separate generate_design_ir calls (one per on-page position) instead of one call with a \`variants\` argument. ` +
        `Every instance of "${dir.id}" in this merge will render identically to whichever single state v${dir.version} captured. Recapture "${dir.id}" with one generate_design_ir call using \`variants\`, then re-run this merge.`
    );
  }

  let instanceOverrideWarnings: string[] = [];
  if (args.perInstanceData) {
    // buildInstanceOverridesFromPerInstanceData needs the *resolved*
    // document (external:<Name> refs already rewritten to real componentIds
    // by the mergeDesignDocuments call(s) above) — a StatCard instance's
    // componentRef is still `external:StatCard` before that, so matching
    // by resolved component name/id would find nothing.
    const primaryComponentIds = new Set(primary.components.map((c) => c.id));
    const resolvedPrimaryComponents = mergeResult.document.components.filter((c) => primaryComponentIds.has(c.id));
    const derived = buildInstanceOverridesFromPerInstanceData(resolvedPrimaryComponents, mergeResult.document.components, mergeResult.document.assets, args.perInstanceData);
    instanceOverrideWarnings = derived.warnings;

    if (Object.keys(derived.instanceOverrides).length > 0) {
      // Explicit instanceOverrides win over derived ones for the same
      // instance — appended after, since applyInstanceOverrides
      // concatenates in order and a later entry for the same node/path
      // is what a caller reaching for the explicit escape hatch expects
      // to take effect.
      const combinedOverrides: InstanceOverridesInput = {};
      for (const [id, overrides] of Object.entries(derived.instanceOverrides)) combinedOverrides[id] = [...overrides];
      for (const [id, overrides] of Object.entries(args.instanceOverrides ?? {})) combinedOverrides[id] = [...(combinedOverrides[id] ?? []), ...overrides];
      mergeResult = mergeDesignDocuments(primary, dependencies, combinedOverrides);

      // Image-field overrides (e.g. one SessionCard Avatar per learner)
      // reference new AssetRefs the derivation step created but never
      // added to any document itself — mergeDesignDocuments only clones
      // primary's existing assets, so append them here. Each `path` is a
      // real http(s) URL (see the doc comment on newAssets); export's
      // existing fetchAssets step fetches them exactly like any other
      // asset — no export-side changes needed.
      const existingAssetIds = new Set(mergeResult.document.assets.map((a) => a.id));
      for (const asset of derived.newAssets) {
        if (!existingAssetIds.has(asset.id)) {
          mergeResult.document.assets.push(asset);
          existingAssetIds.add(asset.id);
        }
      }
    }

    // Instance ids are stable across the re-merge above (cloneComponent
    // never renames them), so this is safe to apply against whichever
    // mergeResult.document is now final — the original one if no
    // instanceOverrides triggered a re-merge, or the freshly re-merged
    // one otherwise. See applyVariantAssignments's doc comment for why
    // this step exists at all: without it, every instance of a captured
    // componentSet (e.g. three StatCards, or three SessionCards' nested
    // Badges) stays on mergeDesignDocuments's external-ref-resolution
    // default of variants[0], regardless of that instance's own data.
    applyVariantAssignments(mergeResult.document.components, derived.variantAssignments);
  }

  const mergedComponentName = args.mergedCheckpointId ?? `merged-${primaryDir.id}`;
  const mergedDir = await openVersionedCheckpointDir(ctx.projectRoot, mergedComponentName);

  // The merged checkpoint has no single source *file* — it's a
  // combination of other checkpoints — so its "source state" is recorded
  // as exactly which resolved checkpoint refs went into it (so a
  // resuming reader can tell whether re-running the merge would even
  // produce a different result) plus a content hash of the merged
  // *output* itself, which is directly comparable across repeated runs.
  const inputRefs = [`${primaryDir.id}@${versionLabel(primaryDir.version)}`, ...dependencyDirs.map((d) => `${d.id}@${versionLabel(d.version)}`)];
  const contentHash = `sha256:${createHash("sha256").update(stableStringify(mergeResult.document)).digest("hex")}`;
  const manifestSource: CheckpointManifestSource = {
    file: `merge(${inputRefs.join(", ")})`,
    contentHash,
    gitCommit: await getCurrentGitCommit(ctx.projectRoot),
  };

  let manifest = initialManifest(mergedComponentName, manifestSource, ctx.now);
  manifest = await patchManifest(mergedDir, { stages: { sourceInspection: "completed", capture: "completed", interpretation: "completed" } }, manifest, ctx.now);

  const { designIrPath, validation } = await writeDesignIrAndValidation(mergedDir, mergeResult.document);

  if (!validation.valid) {
    // Shouldn't happen — mergeDesignDocuments only recombines documents that
    // already passed design-ir/v1 validation on their own — but fail loudly
    // rather than silently exporting a broken document if it ever does. The
    // merged checkpoint is left on disk either way, for inspection.
    const detail = validation.errors
      .slice(0, 10)
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    manifest = await patchManifest(
      mergedDir,
      { stages: { designIr: "completed", validation: "failed" }, artifacts: { designIr: "design-ir.json", validation: "validation.json" }, validation: { valid: false, errorCount: validation.errors.length } },
      manifest,
      ctx.now
    );
    await upsertCheckpointMapEntry(ctx.projectRoot, manifest, mergedDir, { mapPath: ctx.checkpointMapPath });
    throw new Error(
      `merge_design_ir_checkpoints: merged document failed design-ir/v1 validation at ${mergedDir.path} ` +
        `(${validation.errors.length} error${validation.errors.length === 1 ? "" : "s"}): ${detail} — ` +
        "refusing to export; the merged checkpoint remains on disk for inspection"
    );
  }

  manifest = await patchManifest(
    mergedDir,
    { stages: { designIr: "completed", validation: "completed" }, artifacts: { designIr: "design-ir.json", validation: "validation.json" }, validation: { valid: true, errorCount: 0 } },
    manifest,
    ctx.now
  );

  let artifact: ExportDesignArtifactResult | null = null;
  if (args.exportArtifact ?? true) {
    // Same explicit serialize -> disk -> deserialize boundary the server's
    // export_design_artifact handler enforces for every other path into
    // export (see server.ts's roundTripDocument): consume the document as
    // reconstructed from the checkpoint just written, never the in-memory
    // mergeResult.document reference from step 1.
    const reloaded = await readValidatedDesignIr(mergedDir);
    artifact = await exportDesignArtifactTool(
      { document: reloaded, outputPath: args.outputPath, fetchAssets: args.fetchAssets },
      { projectRoot: ctx.projectRoot, fetchImpl: ctx.fetchImpl, now: ctx.now }
    );
    manifest = await patchManifest(mergedDir, { stages: { export: "completed" } }, manifest, ctx.now);
  }

  await upsertCheckpointMapEntry(ctx.projectRoot, manifest, mergedDir, { mapPath: ctx.checkpointMapPath });

  return {
    mergedCheckpoint: {
      id: mergedDir.id,
      path: mergedDir.path,
      version: mergedDir.version,
      checkpointRef: `${mergedDir.id}@${versionLabel(mergedDir.version)}`,
      designIrPath,
    },
    unresolvedExternalRefs: mergeResult.unresolvedExternalRefs,
    duplicateComponentIds: mergeResult.duplicateComponentIds,
    autoResolvedCheckpoints,
    instanceOverrideWarnings,
    staleCheckpointVersionWarnings,
    artifact,
  };
}

