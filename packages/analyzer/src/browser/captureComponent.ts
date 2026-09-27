import type { Page } from "playwright";
import { collectDomSnapshot } from "./collectDomSnapshot.js";
import { interpretDomSnapshot } from "../evidence/interpretDomSnapshot.js";
import type { RenderCapture } from "../evidence/types.js";

export interface CaptureOptions {
  /** CSS selector identifying the component's root DOM node. */
  selector: string;
  label: string;
  viewport: { width: number; height: number };
  viewportLabel?: string;
  propValues?: Record<string, unknown>;
  /** Recorded onto the resulting RenderCapture verbatim — see RenderCapture.interactionState. The actual interaction is driven by the caller (playwrightCapture.ts) BEFORE calling this function, since it needs the real Playwright `Page`/`Locator` this function doesn't otherwise touch. */
  interactionState?: "hover" | "focus" | "active";
  /**
   * The captured component's display name. Passed through to
   * `collectDomSnapshot` to bound the componentPath walk (see
   * `CollectDomSnapshotArgs.rootComponentName`) — without it, componentPath
   * can still be computed but isn't truncated at this component's own
   * boundary and may include outer app-level wrapper components.
   */
  rootComponentName?: string;
  /** Where to write the cropped screenshot; if omitted, no screenshot is captured. */
  screenshotPath?: string;
  /** Where to write an optional full-page/context screenshot — see docs/architecture.md, "Vision" (component-level primary, page-level optional secondary). */
  contextScreenshotPath?: string;
}

/**
 * Captures one deterministic RenderCapture for an already-rendered
 * component on `page`: a raw DOM snapshot (via `collectDomSnapshot`
 * executed in-page) interpreted into ElementEvidence, plus a bounding-box
 * screenshot crop of just that component.
 *
 * Requires a Playwright `Page` already navigated to the target URL with
 * the component rendered — this function does not navigate or set the
 * viewport itself, since callers (the MCP `capture_component` tool) may
 * want to batch multiple captures against one page instance.
 */
/**
 * Checks whether a captured element's actual React component-ownership
 * chain (`componentPath`, from collectDomSnapshot's getComponentPath)
 * includes the component the caller told captureRenderedComponent it was
 * capturing. Returns an actionable error message if not, or `null` when
 * the capture is fine (including when `rootComponentName` wasn't
 * supplied at all — the check is opt-in, matching componentPath itself).
 * Pulled out as a pure function so this decision is unit-testable without
 * a real Playwright Page, unlike captureRenderedComponent as a whole.
 */
export function verifyCapturedOwner(rootComponentName: string | undefined, selector: string, componentPath: string[] | null): string | null {
  if (!rootComponentName) return null;
  if (componentPath?.includes(rootComponentName)) return null;
  const found = componentPath?.length ? componentPath.join(" > ") : "(no React component ownership found for this element)";
  return (
    `captureRenderedComponent: selector "${selector}" matched an element that does not belong to component ` +
    `"${rootComponentName}" — its actual component ownership chain is: ${found}. ` +
    `Check that the selector is specific enough to uniquely identify "${rootComponentName}"'s own root element.`
  );
}

export async function captureRenderedComponent(page: Page, options: CaptureOptions): Promise<RenderCapture> {
  const raw = await page.evaluate(collectDomSnapshot, {
    selector: options.selector,
    rootComponentName: options.rootComponentName,
  });
  if (!raw) {
    throw new Error(`captureRenderedComponent: no element matched selector "${options.selector}"`);
  }

  // Verify the matched element actually belongs to the component we were
  // told to capture, before doing any further (expensive) work with it —
  // page.locator(...).first()/document.querySelector both silently accept
  // the first DOM match for a selector, with no indication when that
  // match is the wrong element entirely (e.g. a generic class name like
  // ".avatar" or a bare "button" tag selector matching some other
  // component's instance instead of the intended one). Catching that
  // here, before any of the pipeline's expensive stages run (evidence
  // assembly, the AI interpretation call, IR construction), turns a bug
  // that previously surfaced as "the exported component looks subtly
  // wrong" into an immediate, specific, actionable error.
  const ownerError = verifyCapturedOwner(options.rootComponentName, options.selector, raw.componentPath);
  if (ownerError) throw new Error(ownerError);

  let screenshot: RenderCapture["screenshot"] = null;
  if (options.screenshotPath) {
    const locator = page.locator(options.selector);
    await locator.screenshot({ path: options.screenshotPath });
    screenshot = { path: options.screenshotPath, width: raw.rect.width, height: raw.rect.height };
  }

  let contextScreenshot: RenderCapture["contextScreenshot"] = null;
  if (options.contextScreenshotPath) {
    await page.screenshot({ path: options.contextScreenshotPath, fullPage: false });
    contextScreenshot = {
      path: options.contextScreenshotPath,
      width: options.viewport.width,
      height: options.viewport.height,
    };
  }

  // How many elements this selector actually matched — informational even
  // when it's 1 (the common, unambiguous case), and the caller's signal
  // for whether to warn about ambiguity (see playwrightCapture.ts). A
  // selector matching more than one element doesn't fail the way the
  // "no match" and "wrong owner" cases above do — Playwright/DOM APIs
  // silently accept the first match, and that first match might well be
  // the right element (e.g. root-level DOM order happens to match
  // intent) — so this is surfaced as something worth double-checking, not
  // something to reject outright.
  const matchCount = await page.locator(options.selector).count();

  return {
    label: options.label,
    viewport: options.viewport,
    viewportLabel: options.viewportLabel,
    propValues: options.propValues,
    interactionState: options.interactionState,
    dom: interpretDomSnapshot(raw),
    screenshot,
    contextScreenshot,
    capturedUrl: page.url(),
    capturedAt: new Date().toISOString(),
    matchCount,
  };
}

/**
 * Convenience for the "responsive/rendered state" requirement: captures
 * the same already-loaded selector at several viewport sizes, resizing the
 * page between captures. Callers are responsible for anything that must
 * happen after a resize before content settles (e.g. waiting on a resize
 * observer in the target app) — this function only calls
 * `page.setViewportSize` and awaits it.
 */
export async function captureAcrossViewports(
  page: Page,
  selector: string,
  viewports: { name: string; width: number; height: number }[],
  options?: { screenshotDir?: string; rootComponentName?: string }
): Promise<RenderCapture[]> {
  const captures: RenderCapture[] = [];
  for (const vp of viewports) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const screenshotPath = options?.screenshotDir ? `${options.screenshotDir}/${vp.name}.png` : undefined;
    captures.push(
      await captureRenderedComponent(page, {
        selector,
        label: `viewport=${vp.name}`,
        viewport: { width: vp.width, height: vp.height },
        viewportLabel: vp.name,
        rootComponentName: options?.rootComponentName,
        screenshotPath,
      })
    );
  }
  return captures;
}
