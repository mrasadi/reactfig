import { findComponentSelectorsOnPage, debugLog, type FindComponentInstancesResult } from "@reactfig/analyzer";
import { createPlaywrightSession, type PlaywrightSessionOptions } from "./playwrightSession.js";

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

export interface FindSelectorRequest {
  url: string;
  componentName: string;
  viewport?: { width: number; height: number };
}

/**
 * Production default for FindComponentSelectorContext.findInstances: a
 * shared PlaywrightSession (see playwrightSession.ts, the same lifecycle
 * createPlaywrightCapture uses) navigates to the page once, then delegates
 * the actual scan to @reactfig/analyzer's findComponentSelectorsOnPage.
 * This is deliberately its own factory, not a method tacked onto
 * createPlaywrightCapture's returned closure — same reasoning as
 * generate_design_ir and export_design_artifact being separate tools:
 * a caller may want to discover a selector without also running a full
 * (much more expensive) evidence capture.
 */
export function createPlaywrightFindSelector(options: PlaywrightSessionOptions = {}): (request: FindSelectorRequest) => Promise<FindComponentInstancesResult> {
  const session = createPlaywrightSession(options);

  return async (request: FindSelectorRequest): Promise<FindComponentInstancesResult> => {
    const viewport = request.viewport ?? DEFAULT_VIEWPORT;
    const page = await session.getPage(request.url, viewport,true);
    debugLog("selector discovery started", { url: request.url, componentName: request.componentName });
    const result = await findComponentSelectorsOnPage(page, request.componentName);
    debugLog("selector discovery finished", { url: request.url, componentName: request.componentName, matchCount: result.matches.length });
    return result;
  };
}
