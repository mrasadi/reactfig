import { debugLog, type FindComponentInstancesResult } from "@reactfig/analyzer";

export interface FindComponentSelectorArgs {
  /** The running dev server URL where the component is rendered. */
  url: string;
  /** The React component displayName/function name to find — same value generate_design_ir's componentName/rootComponentName expects. */
  componentName: string;
  viewport?: { width: number; height: number };
}

export interface FindComponentSelectorContext {
  /** Production default: createPlaywrightFindSelector (playwrightFindSelector.ts). Test-injectable, same pattern as GenerateDesignIrContext.captureComponent. */
  findInstances: (request: { url: string; componentName: string; viewport?: { width: number; height: number } }) => Promise<FindComponentInstancesResult>;
}

/**
 * A lightweight query, not a pipeline stage: navigates to `url` and
 * reports every specific, ready-to-use CSS selector that actually
 * resolves to an instance of `componentName` on that page — see
 * findComponentInstances.ts for what "resolves to an instance of" means
 * and why this exists (avoiding a guessed selector silently resolving to
 * the wrong element, which generate_design_ir has no way to detect on
 * its own beyond the after-the-fact ownership check in
 * captureRenderedComponent's verifyCapturedOwner).
 *
 * Deliberately returns zero matches, rather than throwing, when nothing
 * on the page is owned by `componentName` — that's a legitimate,
 * informative answer (the component isn't rendered on this page/route
 * right now), not an error condition.
 */
export async function findComponentSelectorTool(args: FindComponentSelectorArgs, ctx: FindComponentSelectorContext): Promise<FindComponentInstancesResult> {
  debugLog("find_component_selector started", { url: args.url, componentName: args.componentName });
  const result = await ctx.findInstances({ url: args.url, componentName: args.componentName, viewport: args.viewport });
  debugLog("find_component_selector finished", { url: args.url, componentName: args.componentName, matchCount: result.matches.length });
  return result;
}
