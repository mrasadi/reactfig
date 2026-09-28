import type { Page } from "playwright";
import { collectDomSnapshot, debugLog } from "@reactfig/analyzer";
import { createPlaywrightSession } from "../playwrightSession.js";
import { CollectionSession, summarize } from "./collectionSession.js";
import type { OutputFormat } from "./types.js";
import { buildOverlayScript, OVERLAY_VERSION } from "./overlayScript.js";
import { writeContinuationSignal, type ContinuationBridge } from "./continuation.js";

export interface InteractiveBrowserOptions {
  entryUrl: string;
  viewport?: { width: number; height: number };
  storageStatePath?: string;
  /** Close the browser automatically once the developer clicks the overlay's own Done/Continue button — see `__reactfigMarkDone` below. Default true, same default as finalize_interactive_capture's own `closeBrowser`. */
  closeOnDone?: boolean;
  /** In-process push for Agent Continuation (docs/adr/0027 section 19, continuation.ts) — optional; the persisted signal (continuation.json) is written either way. */
  continuationBridge?: ContinuationBridge;
}

export interface InteractiveBrowserHandle {
  page: Page;
  close(): Promise<void>;
}

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

/**
 * Toggles the overlay's paint visibility via the bridge function it
 * exposes on `window` (`overlayScript.ts`'s `__reactfigSetOverlayVisible`)
 * — used to hide the overlay for exactly the duration of a screenshot so
 * a large capture target (e.g. a whole dashboard, which the overlay's
 * own panel can otherwise overlap) doesn't get the overlay's own pixels
 * baked into it. Best-effort: a failure here (page mid-navigation, overlay
 * not yet installed) never blocks the capture — `screenshot()` just runs
 * with whatever's currently on screen rather than the whole capture
 * failing over a cosmetic concern.
 */
async function setOverlayVisible(page: Page, visible: boolean): Promise<void> {
  await page
    .evaluate((v) => (window as unknown as { __reactfigSetOverlayVisible?: (visible: boolean) => void }).__reactfigSetOverlayVisible?.(v), visible)
    .catch((err) => {
      debugLog("collection: overlay visibility toggle failed", { visible, error: err instanceof Error ? err.message : String(err) });
    });
}

interface ConfirmSelectionPayload {
  url: string;
  pageTitle: string;
  selector: string;
  componentPath: string[] | null;
  tag: string;
  rect: { x: number; y: number; width: number; height: number };
  /** Output Intent picked in the overlay's own output picker for this selection (docs/architecture.md's Output Intent section) — undefined means "use the collection's default", same convention as everywhere else `output` is optional. */
  outputFormat?: OutputFormat;
}

/**
 * Launches (or attaches to) one Playwright page for the whole interactive
 * session and wires the overlay's bridge functions to `session`. Unlike
 * playwrightCapture.ts's per-capture-call session (one page per distinct
 * URL, re-navigated on demand), this acquires exactly ONE page up front
 * and then never calls `page.goto` again — the developer drives all
 * further navigation themselves, freely, inside the app (see
 * docs/architecture.md, Interactive Capture: "Playwright owns/connects to
 * the browser session, developer freely interacts with the page").
 *
 * IMPORTANT — like playwrightCapture.ts's `applyInteractionState`, this
 * has NOT been exercised against a real browser in this repository's
 * sandboxed dev environment (no network access to a Playwright browser
 * binary here). Every call below is written to Playwright's documented
 * API (`exposeFunction`, `addInitScript`, `Locator.screenshot()`), and
 * the parts that don't need a browser at all — CollectionSession's own
 * persistence, the manifest lifecycle, and the fiber-walk/selector logic
 * the overlay embeds — are fully unit-tested (see test/collection/*).
 * Treat the browser-glue code in this file specifically as needing real-
 * browser QA before relying on it, same disclosure as docs/adr/0023.
 */
export async function attachInteractiveBrowser(session: CollectionSession, options: InteractiveBrowserOptions): Promise<InteractiveBrowserHandle> {
  const playwrightSession = createPlaywrightSession({ storageStatePath: options.storageStatePath });
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;
  const page = await playwrightSession.getPage(options.entryUrl, viewport,false);
  const overlaySource = buildOverlayScript();

  async function pushStateToOverlay(): Promise<void> {
    const summary = summarize(session.getManifest());
    await page.evaluate((s) => (window as unknown as { __reactfigApplyState?: (s: unknown) => void }).__reactfigApplyState?.(s), summary).catch((err) => {
      // Best-effort — the page may have navigated or closed between the
      // capture finishing and this push; the manifest itself is already
      // durably persisted by this point (CollectionSession.captureSelection
      // writes before this is ever called), so a failed UI refresh here
      // never loses data, only a cosmetic update.
      debugLog("collection: overlay state push failed", { error: err instanceof Error ? err.message : String(err) });
    });
  }

  await page.exposeFunction("__reactfigConfirmSelection", async (payload: ConfirmSelectionPayload) => {
    debugLog("collection: selection confirmed in browser", { selector: payload.selector, componentPath: payload.componentPath });
    const rootComponentName = payload.componentPath && payload.componentPath.length > 0 ? payload.componentPath[payload.componentPath.length - 1] : undefined;
    const rawSnapshot = await page.evaluate(collectDomSnapshot, { selector: payload.selector, rootComponentName });
    if (!rawSnapshot) {
      debugLog("collection: DOM snapshot failed — selector no longer resolves", { selector: payload.selector });
      await pushStateToOverlay();
      return;
    }
    // The overlay is a real, painted, on-top element (see
    // overlayScript.ts) — for a large capture target (e.g. a whole
    // dashboard) it can otherwise end up baked into the screenshot's own
    // pixels. Hide it for exactly the duration of this one screenshot
    // call and restore it immediately after, success or failure, so the
    // hidden window is as short as possible and never left stuck hidden.
    await setOverlayVisible(page, false);
    let screenshot: Buffer;
    try {
      screenshot = await page.locator(payload.selector).first().screenshot();
    } finally {
      await setOverlayVisible(page, true);
    }
    await session.captureSelection({
      url: payload.url,
      pageTitle: payload.pageTitle,
      componentPath: payload.componentPath,
      selector: payload.selector,
      tag: payload.tag,
      rect: payload.rect,
      rawSnapshot,
      screenshot,
      outputFormat: payload.outputFormat,
    });
    await pushStateToOverlay();
  });

  await page.exposeFunction("__reactfigRemoveSelection", async (selectionId: string) => {
    await session.remove(selectionId);
    await pushStateToOverlay();
  });

  // Agent Continuation (docs/adr/0027 section 19/20/21): the ONLY new
  // developer-facing action Feature C adds — everything else about
  // Interactive Capture stays exactly as manual as it already was. This
  // is not tied to any particular selection; it marks the WHOLE
  // collection done, same semantic event finalize_interactive_capture's
  // MCP tool already represents, just triggered from the browser side
  // instead of the agent side.
  await page.exposeFunction("__reactfigMarkDone", async () => {
    debugLog("collection: developer clicked Done/Continue in browser", { collectionId: session.collectionId });
    // Finalize BEFORE closing (docs section 20: "the collection must be
    // finalized/persisted before the browser is closed") — same ordering
    // finalize_interactive_capture's own tool already guarantees; this
    // reuses the identical session.finalize(), not a second finalize path.
    await session.finalize();
    // Persisted marker written before the browser closes too — a crash
    // right after this point still leaves an honest, durable record that
    // the developer clicked Done, even if the close() below never runs.
    await writeContinuationSignal(session.dir);
    options.continuationBridge?.signal(session.collectionId);
    await pushStateToOverlay();
    if (options.closeOnDone !== false) {
      await page.context().browser()?.close();
    }
  });

  await page.addInitScript({ content: overlaySource });
  // addInitScript only affects *future* navigations — also inject into
  // whatever's already loaded right now, so the overlay is present
  // immediately without requiring the developer to reload first.
  await page.evaluate(overlaySource);
  debugLog("collection: overlay injected", { overlayVersion: OVERLAY_VERSION });
  await pushStateToOverlay();

  return {
    page,
    close: async () => {
      await page.context().browser()?.close();
    },
  };
}