import { resolve } from "node:path";
import { inspectComponentDependencyTree, type InspectDependencyTreeResult } from "@reactfig/analyzer";

export interface InspectComponentDependencyTreeArgs {
  /** Path to the entry .tsx file, relative to projectRoot (or absolute) — e.g. a screen/page component like Dashboard.tsx. */
  sourceFile: string;
  /** Which exported component to start from in sourceFile. If omitted, the first capitalized named export is used — same default as inspect_component_source. */
  exportName?: string;
  /** How many import hops to follow from the entry component. Default 8. */
  maxDepth?: number;
  /** Overrides the server's default project root for this call only — see packages/mcp/src/projectRoot.ts. Consumed by the server dispatch layer (src/server.ts), not read here; present on this type for documentation/schema purposes. */
  projectRoot?: string;
}

export interface InspectComponentDependencyTreeContext {
  projectRoot: string;
}

/**
 * Like inspect_component_source, but walks the *full* nested composition
 * tree instead of stopping at one import hop.
 *
 * inspect_component_source on Dashboard.tsx reports Sidebar/Header/StatCard/
 * SessionCard — SessionCard's own Avatar/Badge/Button children are simply
 * outside that one call's scope. Discovering the full tree previously meant
 * inspecting every child's file in turn by hand, one hop at a time, easy to
 * stop short of the actual leaves on any real component tree. This makes
 * that walk in one call, which is exactly the shape of information needed
 * before a merge_design_ir_checkpoints call for a composite component: every
 * name returned here (deduplicated by file — a component imported from two
 * places in the tree is only listed once) is a component that will need its
 * own generate_design_ir + checkpoint before the composite can merge
 * cleanly, and `unresolved` is the list of names that can *never* resolve
 * that way (external packages, icon libraries) as opposed to ones simply
 * not generated yet.
 */
export async function inspectComponentDependencyTreeTool(
  args: InspectComponentDependencyTreeArgs,
  ctx: InspectComponentDependencyTreeContext
): Promise<InspectDependencyTreeResult> {
  const absolutePath = resolve(ctx.projectRoot, args.sourceFile);
  return inspectComponentDependencyTree(absolutePath, { exportName: args.exportName, maxDepth: args.maxDepth });
}
