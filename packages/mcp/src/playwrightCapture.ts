import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { captureRenderedComponent, debugLog, type RenderCapture } from "@reactfig/analyzer";
import type { Page } from "playwright";
import { createPlaywrightSession } from "./playwrightSession.js";
import type { CaptureRequest } from "./tools/generateDesignIr.js";

export interface PlaywrightCaptureOptions {
  /**
   * Path to a Playwright `storageState` JSON file (cookies + localStorage)
   * for capturing components that require an authenticated session — e.g.
   * a dashboard behind a login. Entirely optional: the model never
   * handles login (per the brief, "do not require the AI model to handle
   * login" — this is a browser/evidence-layer concern only), and most
   * projects need nothing here at all. Generate one with Playwright's own
   * tooling, e.g.:
   *
   *   npx playwright open http://localhost:3000/login
   *   # log in manually, then in the Playwright inspector:
   *   await context.storageState({ path: ".reactfig/auth.json" })
   *
   * See packages/mcp/README.md, "Authenticated development apps."
   */
  storageStatePath?: string;
  /**
   * Where screenshots are written when a capture requests one (see
   * CaptureRequest.captureScreenshot). Defaults to
   * "<projectRoot>/.reactfig/screenshots" — already excluded by the root
   * .gitignore, same as storageStatePath, since these are disposable local
   * evidence files, not artifacts meant to be committed.
   */
  screenshotDir?: string;
}

/**
 * Production default for GenerateDesignIrContext.captureComponent: uses a
 * shared PlaywrightSession (see playwrightSession.ts) for browser/context/
 * page lifecycle, and delegates the actual DOM/style capture to
 * @reactfig/analyzer's captureRenderedComponent — this file only adds the
 * capture-specific concerns (selector waiting, screenshots) on top.
 *
 * Every stage below has an explicit, bounded timeout, a distinct,
 * actionable error message, and a REACTFIG_DEBUG stage-timing log line —
 * see docs/adr/0012-mcp-portability-and-reliability.md for the original
 * `waitUntil: "networkidle"` timeout bug this replaced, and docs/adr/0013-
 * generate-design-ir-timeout.md for why bounding *this* file's stages
 * turned out not to be sufficient on its own: even with every browser
 * stage individually fast, the *aggregate* wall-clock time of browser
 * capture plus a multi-round-trip local-model tool-calling loop routinely
 * exceeds the MCP protocol's own 60-second default client request
 * timeout — a completely different layer than anything in this file.
 */
/**
 * Simulates the requested DOM interaction on the captured element via
 * real Playwright API calls, so the subsequent DOM/computed-style read
 * reflects `:hover`/`:focus`/`:active` rather than the element's default
 * rendered state. Returns a cleanup function the caller MUST run in a
 * `finally` block — the underlying `page` is reused across captures (see
 * PlaywrightSession), so leaving a mouse button down or an element
 * focused would leak into whatever capture runs next.
 *
 * IMPORTANT — unlike the rest of this file, this specific function has
 * NOT been exercised against a real page: this development environment
 * has no network access to Playwright's browser-binary CDN, so there is
 * no live browser here to verify hover/focus/mousedown timing, event
 * dispatch, or `:active` behavior against. The calls below are written
 * to match Playwright's documented API exactly (`Locator.hover()`,
 * `Locator.focus()`, `Mouse.down()`/`Mouse.up()`), but treat this as
 * needing real-browser QA before relying on it — see
 * docs/adr/0023-interaction-state-capture.md.
 *
 * `:active` has no dedicated Playwright method — the standard technique
 * (hover, then press the mouse button down without releasing it) is used
 * here; `:focus-visible` specifically depends on browser heuristics
 * `Locator.focus()` doesn't control, so a focus capture reflects plain
 * `:focus`, which is what most component styling actually keys off
 * anyway.
 */
export async function applyInteractionState(page: Page, selector: string, state: CaptureRequest["interactionState"]): Promise<() => Promise<void>> {
  if (!state) return async () => {};
  const locator = page.locator(selector).first();

  if (state === "hover") {
    await locator.hover();
    return async () => {}; // nothing to release — the next capture's own navigation/selector-wait naturally supersedes this
  }
  if (state === "focus") {
    await locator.focus();
    return async () => {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    };
  }
  // active
  await locator.hover();
  await page.mouse.down();
  return async () => {
    await page.mouse.up();
  };
}

export function createPlaywrightCapture(options: PlaywrightCaptureOptions = {}): (request: CaptureRequest) => Promise<RenderCapture> {
  const session = createPlaywrightSession({ storageStatePath: options.storageStatePath });
  const SELECTOR_TIMEOUT_MS = 10_000;

  async function resolveScreenshotDir(): Promise<string> {
    const dir = options.screenshotDir ?? join(process.cwd(), ".reactfig", "screenshots");
    await mkdir(dir, { recursive: true });
    return dir;
  }

  return async (request: CaptureRequest): Promise<RenderCapture> => {
    // Best-effort cancellation: if the caller's signal is already aborted
    // (e.g. the MCP client disconnected while an earlier capture in this
    // same tool call was running), bail out before doing any more browser
    // work rather than starting a navigation/capture that nothing will
    // read the result of. See docs/adr/0013.
    if (request.signal?.aborted) {
      throw new Error("Capture cancelled before it started (request signal was already aborted)");
    }

    const page = await session.getPage(request.url, request.viewport,true);

    debugLog("selector wait started", { selector: request.selector });
    try {
      await page.locator(request.selector).first().waitFor({ state: "attached", timeout: SELECTOR_TIMEOUT_MS });
      debugLog("selector resolved", { selector: request.selector });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debugLog("selector wait failed", { selector: request.selector, error: message });
      throw new Error(`Selector "${request.selector}" was not found on ${request.url} within ${SELECTOR_TIMEOUT_MS}ms: ${message}`);
    }

    let screenshotPath: string | undefined;
    let contextScreenshotPath: string | undefined;
    if (request.captureScreenshot) {
      // Deliberately conditional, not "always capture, decide later
      // whether to send it to the model" — a screenshot is one more
      // sequential browser round-trip inside a request that already has a
      // hard wall-clock budget (docs/adr/0013), so it's skipped entirely
      // when the configured model has no vision capability to use it.
      const dir = await resolveScreenshotDir();
      const safeLabel = request.label.replace(/[^a-z0-9_.=-]/gi, "_");
      screenshotPath = join(dir, `${request.rootComponentName}-${safeLabel}.png`);
      contextScreenshotPath = join(dir, `${request.rootComponentName}-${safeLabel}-context.png`);
    }

    let releaseInteraction: () => Promise<void> = async () => {};
    if (request.interactionState) {
      debugLog("interaction simulation started", { selector: request.selector, interactionState: request.interactionState });
      try {
        releaseInteraction = await applyInteractionState(page, request.selector, request.interactionState);
        // Best-effort settle wait for any hover/focus CSS transition —
        // see applyInteractionState's doc comment for why this specific
        // timing hasn't been verified against a real browser here.
        await page.waitForTimeout(150);
        debugLog("interaction simulation finished", { selector: request.selector, interactionState: request.interactionState });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        debugLog("interaction simulation failed", { selector: request.selector, interactionState: request.interactionState, error: message });
        throw new Error(`Simulating "${request.interactionState}" on selector "${request.selector}" failed: ${message}`);
      }
    }

    debugLog("DOM snapshot started", { selector: request.selector });
    if (screenshotPath) debugLog("component screenshot started", { path: screenshotPath });
    try {
      const capture = await captureRenderedComponent(page, {
        selector: request.selector,
        label: request.label,
        viewport: request.viewport,
        viewportLabel: request.viewportLabel,
        propValues: request.propValues,
        interactionState: request.interactionState,
        rootComponentName: request.rootComponentName,
        screenshotPath,
        contextScreenshotPath,
      });
      debugLog("DOM snapshot finished", { selector: request.selector });
      if (screenshotPath) debugLog("component screenshot finished", { path: screenshotPath });
      if (contextScreenshotPath) debugLog("context screenshot finished", { path: contextScreenshotPath });
      if (capture.matchCount && capture.matchCount > 1) {
        debugLog("selector matched multiple elements", { selector: request.selector, matchCount: capture.matchCount });
      }
      return capture;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debugLog("DOM/screenshot capture failed", { selector: request.selector, error: message });
      throw new Error(`DOM/screenshot capture failed for selector "${request.selector}" on ${request.url}: ${message}`);
    } finally {
      // MUST run even on failure — the page is reused across captures
      // (see PlaywrightSession), so a stuck mousedown/focus would leak
      // into whatever capture runs next otherwise.
      await releaseInteraction().catch((err) => {
        debugLog("interaction cleanup failed", { selector: request.selector, error: err instanceof Error ? err.message : String(err) });
      });
    }
  };
}
