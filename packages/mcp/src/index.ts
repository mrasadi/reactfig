export { createProviderFromEnv } from "./providerConfig.js";
export { resolveProjectRoot, resolveExplicitRoot, type ProjectRootState } from "./projectRoot.js";

export {
  openVersionedCheckpointDir,
  resolveCheckpointRef,
  checkpointFile,
  writeCheckpoint,
  readCheckpoint,
  tryReadCheckpoint,
  readValidatedDesignIr,
  writeDesignIrAndValidation,
  sanitizeRequestId,
  versionLabel,
  initialManifest,
  readManifest,
  patchManifest,
  CHECKPOINT_FILES,
  CHECKPOINT_LAYOUT_VERSION,
  PIPELINE_VERSION,
  MANIFEST_STAGES,
  type CheckpointDir,
  type CheckpointName,
  type CheckpointManifest,
  type CheckpointManifestSource,
  type ManifestStage,
  type StageStatus,
} from "./checkpoint.js";

export {
  readCheckpointMap,
  upsertCheckpointMapEntry,
  rebuildCheckpointMap,
  CHECKPOINT_MAP_SCHEMA_VERSION,
  type CheckpointMap,
  type CheckpointMapEntry,
} from "./checkpointMap.js";

export { getCurrentGitCommit, isFileDirty, getChangedFilesSince, hashFileContent } from "./git.js";

export {
  inspectComponentSourceTool,
  type InspectComponentSourceArgs,
  type InspectComponentSourceContext,
} from "./tools/inspectComponentSource.js";

export {
  inspectComponentDependencyTreeTool,
  type InspectComponentDependencyTreeArgs,
  type InspectComponentDependencyTreeContext,
} from "./tools/inspectComponentDependencyTree.js";

export {
  generateDesignIrTool,
  type GenerateDesignIrArgs,
  type GenerateDesignIrContext,
  type GenerateDesignIrResult,
  type CaptureRequest,
  type ViewportSpec,
  type VariantCaptureSpec,
} from "./tools/generateDesignIr.js";

export {
  exportDesignArtifactTool,
  type ExportDesignArtifactArgs,
  type ExportDesignArtifactContext,
  type ExportDesignArtifactResult,
} from "./tools/exportDesignArtifact.js";

export { validateDesignIrTool, type ValidateDesignIrArgs } from "./tools/validateDesignIr.js";

export {
  mergeDesignIrDocumentsTool,
  type MergeDesignIrDocumentsArgs,
} from "./tools/mergeDesignIrDocuments.js";

export {
  mergeDesignIrCheckpointsTool,
  type MergeDesignIrCheckpointsArgs,
  type MergeDesignIrCheckpointsContext,
  type MergeDesignIrCheckpointsResult,
} from "./tools/mergeDesignIrCheckpoints.js";

export {
  diffDesignIrTool,
  type DiffDesignIrArgs,
  type DiffDesignIrContext,
  type DiffDesignIrResult,
} from "./tools/diffDesignIr.js";

export { createPlaywrightCapture, type PlaywrightCaptureOptions } from "./playwrightCapture.js";

export {
  startInteractiveCaptureTool,
  type StartInteractiveCaptureArgs,
  type StartInteractiveCaptureContext,
  type StartInteractiveCaptureResult,
} from "./tools/startInteractiveCapture.js";

export {
  getInteractiveCaptureStatusTool,
  type GetInteractiveCaptureStatusArgs,
  type GetInteractiveCaptureStatusContext,
  type GetInteractiveCaptureStatusResult,
} from "./tools/getInteractiveCaptureStatus.js";

export {
  finalizeInteractiveCaptureTool,
  type FinalizeInteractiveCaptureArgs,
  type FinalizeInteractiveCaptureContext,
  type FinalizeInteractiveCaptureResult,
} from "./tools/finalizeInteractiveCapture.js";

export {
  generateDesignIrFromCaptureTool,
  type GenerateDesignIrFromCaptureArgs,
  type GenerateDesignIrFromCaptureContext,
} from "./tools/generateDesignIrFromCapture.js";

export { CollectionSession, summarize, type CapturedSelectionInput, type CollectionSummary } from "./collection/collectionSession.js";
export { createCollectionCapture } from "./collection/collectionCapture.js";
export { attachInteractiveBrowser, type InteractiveBrowserOptions, type InteractiveBrowserHandle } from "./collection/collectionBrowser.js";
export { buildOverlayScript } from "./collection/overlayScript.js";
export {
  createManifest,
  addSelection,
  updateSelection,
  removeSelection,
  beginCollecting,
  beginFinalize,
  completeFinalize,
  readCollectionManifest,
  writeCollectionManifest,
  CollectionStateError,
} from "./collection/collectionManifest.js";
export { activeSelections, type CollectionManifest, type CollectionSelection, type CollectionStatus, type SelectionStatus } from "./collection/types.js";
export {
  collectionsRootDir,
  collectionDir,
  manifestPath,
  selectionDir,
  selectionEvidencePath,
  selectionScreenshotPath,
  generateCollectionId,
  generateSelectionId,
} from "./collection/paths.js";