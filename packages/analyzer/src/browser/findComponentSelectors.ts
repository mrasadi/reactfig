import type { Page } from "playwright";
import { findComponentInstances, type FindComponentInstancesResult } from "./findComponentInstances.js";

/**
 * Runs findComponentInstances (see its doc comment) against an
 * already-navigated page and returns every matching selector for the
 * named component. Requires a Playwright `Page` already at the target
 * URL with the component rendered — same contract as
 * captureRenderedComponent, and for the same reason: callers may want to
 * batch this against a page they're already managing.
 */
export async function findComponentSelectorsOnPage(page: Page, componentName: string): Promise<FindComponentInstancesResult> {
  return page.evaluate(findComponentInstances, { componentName });
}
