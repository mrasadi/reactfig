export * from "./types.js";
export { validateDesignIR, assertDesignIR, type ValidationResult, type ValidationError } from "./validate.js";
export {
  mergeDesignDocuments,
  findUnresolvedExternalRefs,
  findNodePath,
  buildInstanceOverridesFromPerInstanceData,
  applyVariantAssignments,
  type MergeDesignDocumentsResult,
  type InstanceOverridesInput,
  type PerInstanceDataItem,
  type BuildInstanceOverridesResult,
} from "./merge.js";
export { stableStringify, stableParse, sortKeysDeep } from "./stableJson.js";
export {
  diffDesignDocuments,
  formatDesignIrDiff,
  type DiffCategory,
  type DiffChangeType,
  type DiffEntry,
  type DesignIrDiffResult,
} from "./diff.js";