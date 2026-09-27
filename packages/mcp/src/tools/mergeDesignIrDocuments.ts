import { mergeDesignDocuments, type DesignDocument, type MergeDesignDocumentsResult, type InstanceOverridesInput } from "@reactfig/core";

export interface MergeDesignIrDocumentsArgs {
  /** The "outer" document — e.g. a SessionCard generated via generate_design_ir — whose external:<Name> nested-instance refs (ADR 0008's documented known limitation) should be resolved. */
  primary: DesignDocument;
  /** Documents for the nested components the primary references (e.g. Avatar, Badge, Button), each generated the same way via generate_design_ir pointed at that component's own source file. */
  dependencies: DesignDocument[];
  /**
   * Per-instance content overrides keyed by the target instance node's id
   * in `primary` — see @reactfig/core's `InstanceOverride`/`findNodePath`.
   * Fixes "every instance of a template component renders identical
   * content" (Issue.md Fix 2c) for callers driving merge_design_ir_documents
   * directly rather than through checkpoints.
   */
  instanceOverrides?: InstanceOverridesInput;
}

/**
 * Thin wrapper around @reactfig/core's mergeDesignDocuments — see that
 * module for the actual merge/resolution logic. This tool exists so a
 * client can combine independently generated documents (generate_design_ir
 * only ever produces one component's own document at a time — batch
 * multi-component orchestration is a later phase, per ADR 0008) into one
 * document ready for export_design_artifact, without hand-rolling the id
 * namespacing and componentId rewriting itself.
 */
export async function mergeDesignIrDocumentsTool(args: MergeDesignIrDocumentsArgs): Promise<MergeDesignDocumentsResult> {
  return mergeDesignDocuments(args.primary, args.dependencies, args.instanceOverrides);
}
