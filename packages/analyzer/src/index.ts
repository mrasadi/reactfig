export * from "./evidence/types.js";
export { parsePx, parseColor, parseCornerRadius, parseCssUrl, classifyLayoutMode } from "./evidence/parse.js";
export { interpretDomSnapshot } from "./evidence/interpretDomSnapshot.js";

export type { RawDomSnapshot } from "./browser/rawTypes.js";
export { collectDomSnapshot, COMPUTED_STYLE_PROPERTIES } from "./browser/collectDomSnapshot.js";
export { captureRenderedComponent, captureAcrossViewports, verifyCapturedOwner, type CaptureOptions } from "./browser/captureComponent.js";
export {
  findComponentInstances,
  type FindComponentInstancesArgs,
  type FindComponentInstancesResult,
  type ComponentInstanceMatch,
} from "./browser/findComponentInstances.js";
export { findComponentSelectorsOnPage } from "./browser/findComponentSelectors.js";
export {
  resolveComponentBoundary,
  type ResolveComponentBoundaryArgs,
  type ComponentBoundaryResult,
} from "./browser/resolveComponentBoundary.js";

export {
  inspectComponentSource,
  inspectComponentSourceFromFile,
  type InspectSourceOptions,
} from "./ast/inspectComponentSource.js";
export { detectPortalUsage } from "./ast/detectPortalUsage.js";
export {
  inspectComponentDependencyTree,
  type InspectDependencyTreeOptions,
  type InspectDependencyTreeResult,
  type DependencyTreeNode,
} from "./ast/inspectComponentDependencyTree.js";
export {
  extractMappedDataRefs,
  type MappedItemField,
  type MappedDataSource,
  type MappedComponentUsage,
} from "./ast/extractMappedDataRefs.js";
export {
  discoverVariantCaptures,
  buildVariantCandidates,
  findVariantAxisFields,
  type VariantCaptureCandidate,
  type DiscoverVariantCapturesResult,
} from "./ast/discoverVariantCaptures.js";
export {
  extractStaticUsageVariants,
  type StaticComponentUsage,
  type StaticUsageVariantCandidate,
} from "./ast/extractStaticUsageVariants.js";

export { buildComponentEvidence, type BuildComponentEvidenceOptions } from "./buildComponentEvidence.js";

// AI orchestration (Phase 4) — see docs/analyzer/ai-orchestration.md
export type { ComponentInterpretation, VariantAxisInterpretation, NodeAnnotation, NodeSemanticType } from "./ai/types.js";
export { buildComponentInterpretationSchema } from "./ai/schema.js";
export { EvidenceStore } from "./ai/evidenceStore.js";
export { GET_EVIDENCE_TOOL, executeGetEvidenceTool } from "./ai/tools.js";
export { buildInitialBundle } from "./ai/evidenceBundle.js";
export { interpretComponent, MAX_TOOL_ITERATIONS, type InterpretOptions, type InterpretResult } from "./ai/interpret.js";
export { buildDesignIR } from "./ai/buildDesignIR.js";
export { generateDesignIR, type OrchestrateOptions, type OrchestrateResult } from "./ai/orchestrate.js";
export type { ProgressReporter } from "./ai/progress.js";

// Diagnostics (Phase 8) — see docs/adr/0013-generate-design-ir-timeout.md
export { debugLog, isDebugEnabled } from "@reactfig/model";
