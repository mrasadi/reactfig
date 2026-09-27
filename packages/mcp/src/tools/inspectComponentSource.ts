import { resolve } from "node:path";
import { inspectComponentSource, type ComponentSourceEvidence } from "@reactfig/analyzer";

export interface InspectComponentSourceArgs {
  /** Path to the .tsx file, relative to projectRoot (or absolute). */
  sourceFile: string;
  exportName?: string;
  /** Overrides the server's default project root for this call only — see packages/mcp/src/projectRoot.ts. Consumed by the server dispatch layer (src/server.ts), not read here; present on this type for documentation/schema purposes. */
  projectRoot?: string;
}

export interface InspectComponentSourceContext {
  projectRoot: string;
}

/**
 * Exposes @reactfig/analyzer's AST layer directly — no browser, no model.
 * Useful on its own for a quick "what props/variants does this component
 * declare" check, and as the first step generate_design_ir performs
 * internally (this tool duplicates none of that logic; both call the same
 * `inspectComponentSource` function from @reactfig/analyzer).
 */
export async function inspectComponentSourceTool(
  args: InspectComponentSourceArgs,
  ctx: InspectComponentSourceContext
): Promise<ComponentSourceEvidence> {
  const absolutePath = resolve(ctx.projectRoot, args.sourceFile);
  return inspectComponentSource(absolutePath, { exportName: args.exportName });
}