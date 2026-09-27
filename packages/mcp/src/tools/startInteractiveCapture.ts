import { CollectionSession } from "../collection/collectionSession.js";
import type { CollectionManifest, CollectionStatus, OutputFormat } from "../collection/types.js";
import type { InteractiveBrowserHandle, InteractiveBrowserOptions } from "../collection/collectionBrowser.js";
import type { ContinuationBridge } from "../collection/continuation.js";

export interface StartInteractiveCaptureArgs {
  /** The running dev server URL to open the browser against. Ignored (and optional) when resuming an existing collectionId — the collection's own recorded entryUrl is used instead. */
  url?: string;
  /** Resume a previously started, not-yet-finalized collection instead of starting a new one — e.g. after a browser crash or an OpenCode/Claude Code process restart (see docs/architecture.md, "Recovery"). */
  collectionId?: string;
  /** Browser viewport size for this session. Defaults to 1440x900 (or whatever the server configures via StartInteractiveCaptureContext.viewport) — useful for interactively capturing a responsive/mobile layout instead of desktop. */
  viewport?: { width: number; height: number };
  /** Overrides the server's default project root for this call only. */
  projectRoot?: string;
  /**
   * Collection-level default Output Intent (docs/architecture.md's Output
   * Intent section) — what every selection exports as unless it picks its
   * own override in the overlay's output picker. Omit to keep the
   * backward-compatible default: "rfd" wherever nothing else specifies a
   * format (see `resolveOutputFormat`). Ignored when resuming an existing
   * collectionId (its own recorded default, if any, is kept).
   */
  defaultOutputFormat?: OutputFormat;
}

export interface StartInteractiveCaptureContext {
  projectRoot: string;
  /** Real implementation launches/attaches a Playwright page (collectionBrowser.ts's attachInteractiveBrowser); tests inject a fake one, same pattern as GenerateDesignIrContext.captureComponent. */
  attachBrowser: (session: CollectionSession, options: InteractiveBrowserOptions) => Promise<InteractiveBrowserHandle>;
  /** Tracks the live session+browser handle for the lifetime of the server process, so a later get_interactive_capture_status/finalize_interactive_capture call for the same collectionId can reach the same open browser page instead of only the on-disk manifest. */
  registerActiveSession: (collectionId: string, entry: { session: CollectionSession; browser: InteractiveBrowserHandle }) => void;
  /**
   * Prunes a collectionId's entry from that same registry. Passed through
   * to this tool (rather than only to finalize_interactive_capture) so an
   * abandoned collection — the developer closes the browser tab by hand,
   * or it crashes, and never calls finalize_interactive_capture at all —
   * doesn't hold a dead Page/browser reference in server memory for the
   * rest of the process's life. Wired up below via the page's own
   * `close`/browser `disconnected` events, not polled.
   */
  dropActiveSession?: (collectionId: string) => void;
  storageStatePath?: string;
  /** Server-configured default viewport, used when the call itself doesn't specify one. */
  viewport?: { width: number; height: number };
  /** Agent Continuation (docs/adr/0027 section 19) — shared across the whole server process, passed through to attachInteractiveBrowser so this collection's Done/Continue click can push in-process, on top of the persisted signal it always writes regardless. Optional — omitting it only loses the in-process push, never the persisted marker. */
  continuationBridge?: ContinuationBridge;
}

export interface StartInteractiveCaptureResult {
  collectionId: string;
  status: CollectionStatus;
  entryUrl: string;
  manifest: CollectionManifest;
  message: string;
}

/**
 * Starts (or resumes) Interactive Capture: a browser opens against the
 * developer's running application with the capture overlay already
 * present, and the developer takes over from there — navigating, logging
 * in, and selecting elements freely — with no further MCP call required
 * until they're ready to check status or finalize. This call itself
 * returns as soon as the browser is attached and the overlay is
 * confirmed present; it does NOT block waiting for the developer to
 * finish (see docs/architecture.md's rationale for start/status/finalize
 * over one long-running call: a human-paced browsing session has no
 * natural upper bound, and this codebase has already hit real MCP
 * client timeout problems with much shorter, fully-automated calls —
 * docs/adr/0013).
 */
export async function startInteractiveCaptureTool(args: StartInteractiveCaptureArgs, ctx: StartInteractiveCaptureContext): Promise<StartInteractiveCaptureResult> {
  const session = args.collectionId
    ? await CollectionSession.resume({ projectRoot: ctx.projectRoot, collectionId: args.collectionId })
    : await CollectionSession.create({ projectRoot: ctx.projectRoot, entryUrl: requireUrl(args.url), defaultOutputFormat: args.defaultOutputFormat });

  const manifest = session.getManifest();
  const browser = await ctx.attachBrowser(session, {
    entryUrl: manifest.entryUrl,
    storageStatePath: ctx.storageStatePath,
    viewport: args.viewport ?? ctx.viewport,
    continuationBridge: ctx.continuationBridge,
  });
  ctx.registerActiveSession(session.collectionId, { session, browser });

  // Self-heals the registry if the developer closes the browser (or it
  // crashes) without ever calling finalize_interactive_capture — without
  // this, that entry would hold a dead Page reference in server memory
  // for the rest of the process's life. `once`, not `on`: this fires at
  // most once per session regardless of which event gets there first,
  // and finalize_interactive_capture's own explicit drop (Map.delete on
  // an already-removed key) is a harmless no-op if this already ran.
  if (ctx.dropActiveSession) {
    const dropThisSession = () => ctx.dropActiveSession?.(session.collectionId);
    browser.page.once("close", dropThisSession);
    browser.page
      .context()
      .browser()
      ?.once("disconnected", dropThisSession);
  }

  return {
    collectionId: session.collectionId,
    status: manifest.status,
    entryUrl: manifest.entryUrl,
    manifest,
    message:
      manifest.status === "completed"
        ? `Collection "${session.collectionId}" is already finalized — reopened for reference only, no new selections can be added. Start a fresh collection to capture more.`
        : `Browser opened at ${manifest.entryUrl}. Use the floating ReactFig panel to select elements, then call finalize_interactive_capture with collectionId "${session.collectionId}" when done.`,
  };
}

function requireUrl(url: string | undefined): string {
  if (!url) {
    throw new Error("start_interactive_capture: `url` is required when starting a new collection (omit it only when resuming via `collectionId`).");
  }
  return url;
}