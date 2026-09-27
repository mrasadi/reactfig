import type { Browser, BrowserContext, Page } from "playwright";
import { debugLog } from "@reactfig/analyzer";

export interface PlaywrightSessionOptions {
  /** See PlaywrightCaptureOptions.storageStatePath in playwrightCapture.ts — same option, same rationale. */
  storageStatePath?: string;
}

export interface PlaywrightSession {
  /** Navigates to `url` (reusing an existing page for that exact URL if one is already open) and sets `viewport`, returning the ready `Page`. */
  getPage(url: string, viewport: { width: number; height: number }, headless: boolean): Promise<Page>;
}

/**
 * Shared browser/context/page lifecycle for anything that needs a real
 * Playwright `Page` pointed at a running dev server — currently
 * createPlaywrightCapture (evidence capture) and
 * createPlaywrightFindSelector (selector discovery). Pulled out of
 * playwrightCapture.ts so both share one launch/navigation
 * implementation rather than two copies of the same timeouts, error
 * messages, and the `waitUntil: "load"` fix (docs/adr/0012) drifting
 * apart over time.
 *
 * Lazily launches one Chromium instance and reuses one context
 * (optionally pre-authenticated via `storageStatePath`) and one page per
 * distinct URL, for the lifetime of whichever factory function created
 * this session — each call to `createPlaywrightCapture`/
 * `createPlaywrightFindSelector` creates its own new session today (see
 * their call sites in server.ts), so this reuse currently spans one MCP
 * tool call, not the whole server process.
 */
export function createPlaywrightSession(options: PlaywrightSessionOptions = {}): PlaywrightSession {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  const pages = new Map<string, Page>();

  const LAUNCH_TIMEOUT_MS = 30_000;
  const NAVIGATION_TIMEOUT_MS = 15_000;

  async function ensureContext(headless: boolean = true): Promise<BrowserContext> {
    if (context) return context;
    if (!browser) {
      debugLog("browser launch started");
      try {
        const { chromium } = await import("playwright");
        browser = await chromium.launch({ headless, timeout: LAUNCH_TIMEOUT_MS });
        debugLog("browser launch finished");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        debugLog("browser launch failed", { error: message });
        const hint = /executable doesn't exist|missing dependencies/i.test(message)
          ? ' Run "npx playwright install chromium" (see docs/e2e/phase7-report.md, "Real browser capture" for the full manual procedure) and try again.'
          : "";
        throw new Error(`Browser launch failed: ${message}.${hint}`);
      }
    }
    try {
      context = await browser.newContext(options.storageStatePath ? { storageState: options.storageStatePath } : {});
      return context;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const suffix = options.storageStatePath ? ` (storageState: "${options.storageStatePath}")` : "";
      throw new Error(`Browser context creation failed${suffix}: ${message}`);
    }
  }

  async function getPage(url: string, viewport: { width: number; height: number }, headless: boolean = true): Promise<Page> {
    const activeContext = await ensureContext(headless);

    debugLog("page creation started", { url });
    let page = pages.get(url);
    if (!page) {
      page = await activeContext.newPage();
      pages.set(url, page);
    }
    await page.setViewportSize(viewport);
    debugLog("page creation finished", { url });

    if (page.url() !== url) {
      debugLog("navigation started", { url });
      try {
        // "load" rather than "networkidle": networkidle waits for zero
        // in-flight network requests for 500ms straight, which never
        // resolves for apps with polling, websockets, or analytics beacons
        // — this was the actual root cause of an earlier real timeout bug
        // (docs/adr/0012). "load" (the page's load event) is what every
        // browser actually fires once, deterministically.
        await page.goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
        debugLog("navigation finished", { url });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        debugLog("navigation failed", { url, error: message });
        throw new Error(`Navigation to "${url}" failed or exceeded ${NAVIGATION_TIMEOUT_MS}ms: ${message}`);
      }
    }
    return page;
  }

  return { getPage };
}
