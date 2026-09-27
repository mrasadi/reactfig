#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { debugLog } from "@reactfig/analyzer";
import { assertDesignIR } from "@reactfig/core";
import { createProviderFromEnv } from "./providerConfig.js";
import { createPlaywrightCapture } from "./playwrightCapture.js";
import { createPlaywrightFindSelector } from "./playwrightFindSelector.js";
import { resolveExplicitRoot, resolveProjectRoot, type ProjectRootState } from "./projectRoot.js";
import { makeProgressReporter } from "./progressReporter.js";
import { maxRepairAttemptsSchema, maxToolIterationsSchema } from "./toolSchemas.js";
import { inspectComponentSourceTool } from "./tools/inspectComponentSource.js";
import { inspectComponentDependencyTreeTool } from "./tools/inspectComponentDependencyTree.js";
import { generateDesignIrTool } from "./tools/generateDesignIr.js";
import { findComponentSelectorTool } from "./tools/findComponentSelector.js";
import { exportDesignArtifactTool } from "./tools/exportDesignArtifact.js";
import { exportDesignOutputTool } from "./tools/exportDesignOutput.js";
import { validateDesignIrTool } from "./tools/validateDesignIr.js";
import { mergeDesignIrDocumentsTool } from "./tools/mergeDesignIrDocuments.js";
import { mergeDesignIrCheckpointsTool } from "./tools/mergeDesignIrCheckpoints.js";
import { diffDesignIrTool } from "./tools/diffDesignIr.js";
import { startInteractiveCaptureTool } from "./tools/startInteractiveCapture.js";
import { getInteractiveCaptureStatusTool } from "./tools/getInteractiveCaptureStatus.js";
import { finalizeInteractiveCaptureTool } from "./tools/finalizeInteractiveCapture.js";
import { generateDesignIrFromCaptureTool } from "./tools/generateDesignIrFromCapture.js";
import { attachInteractiveBrowser, type InteractiveBrowserHandle } from "./collection/collectionBrowser.js";
import { ContinuationBridge } from "./collection/continuation.js";
import type { CollectionSession } from "./collection/collectionSession.js";
import { resolveCheckpointRef, readManifest, patchManifest, readValidatedDesignIr } from "./checkpoint.js";
import { upsertCheckpointMapEntry } from "./checkpointMap.js";
import { stableStringify, stableParse } from "@reactfig/core";
import type { ModelProvider } from "@reactfig/model";

function toResult(value: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/**
 * Wraps a tool's handler with the same received/completed/failed
 * debugLog triple every tool needs, plus try/catch failure logging —
 * previously hand-copied into each of the 13 registrations below with
 * inconsistent coverage (a few omitted the try/catch and never logged a
 * failure at all, purely because whoever added that particular tool
 * didn't copy that part too). One shared wrapper means every tool gets
 * uniform observability for free, and a future tool can't add itself
 * without it.
 *
 * Deliberately generic over the handler's exact signature (some tools
 * take just `args`, generate_design_ir_from_capture also takes MCP's
 * `extra` for progress/cancellation) rather than typed against a
 * specific tool shape — this only wraps timing/logging around whatever
 * handler is passed in, without changing its inputs, outputs, or the
 * tool-specific logic inside it.
 */
function withToolLogging<A extends unknown[], R>(toolName: string, handler: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    debugLog("MCP request received", { tool: toolName });
    try {
      const result = await handler(...args);
      debugLog("request completed", { tool: toolName });
      return result;
    } catch (err) {
      debugLog("request failed", { tool: toolName, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  };
}

/**
 * MCP boundary normalization (see export_design_artifact's handler for the
 * full rationale): a `document`-shaped argument declared `z.unknown()` may
 * arrive as a real object, or as a JSON string if the calling client
 * forwarded a prior tool result's raw text without re-parsing it. Normalize
 * once, here, for any tool that accepts one or more documents as input.
 */
function normalizeDocumentArg(raw: unknown, label: string): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${label}: was a string but not valid JSON (${(err as Error).message}). ` +
        "Pass the parsed design-ir/v1 object (e.g. generate_design_ir's `document` field), not its serialized text."
    );
  }
}

/**
 * Best-effort MCP progress reporting — see ./progressReporter.ts and
 * docs/adr/0013-generate-design-ir-timeout.md.
 */

/**
 * The explicit serialization/deserialization boundary the export stage
 * must cross: take whatever object a prior stage handed us, run it through
 * `stableStringify` → `stableParse` (the same deterministic JSON the
 * checkpoint layer writes to disk), and hand the *reconstructed* object —
 * not the original in-memory reference — to the exporter.
 *
 * This is the invariant PROMPT.md demands: `JSON.stringify(doc) → disk →
 * JSON.parse → export` must produce the same structural object. Forcing the
 * round-trip here, rather than trusting an in-memory object that "happened
 * to be returned by the previous tool call", is what makes a field lost in
 * transit (the `assets` undefined that produced
 * `args.document.assets is not iterable`) surface as a real design-ir/v1
 * validation error instead of a raw TypeError deep in the asset-fetch loop.
 *
 * Note: this does NOT add a special-case like `if (!Array.isArray(doc.assets))
 * doc.assets = []` — that would hide the serialization/schema bug. The
 * round-trip preserves whatever is actually there; the validator that
 * follows is what rejects a document missing a required array.
 */
function roundTripDocument(raw: unknown, label: string): unknown {
  debugLog("export boundary: round-tripping document through JSON", { label, typeofInput: typeof raw });
  const parsed = stableParse(stableStringify(raw));
  debugLog("export boundary: round-trip complete", {
    label,
    typeofAssets: typeof (parsed as { assets?: unknown })?.assets,
    assetsIsArray: Array.isArray((parsed as { assets?: unknown })?.assets),
   });
  return parsed;
}

const instanceOverrideSchema = z.object({
  path: z
    .array(z.number().int().nonnegative())
    .describe(
      "Child-index path from the target instance's own root down to the node being overridden, crossing transparently into any nested instance along the way. Compute it with @reactfig/core's findNodePath(document, componentId, targetNodeId) rather than hand-counting — pass the *instance's* referenced componentId and the id of the descendant node to target."
    ),
  characters: z.string().optional().describe("New text content, when the target node is a Text node."),
  fills: z.array(z.unknown()).optional().describe("Replacement Fill[] for the target node (e.g. a Badge's tone color or an accent border's fill)."),
  strokes: z.array(z.unknown()).optional().describe("Replacement Stroke[] for the target node."),
});

const instanceOverridesSchema = z
  .record(z.string(), z.array(instanceOverrideSchema))
  .optional()
  .describe(
    "Per-instance content overrides, keyed by the target instance node's id in the primary document (e.g. one of three `.map()`-rendered StatCard instances). Fixes 'every instance of a template component renders identical content' — without this, every instance of the same component necessarily shows whatever text/fills the component was captured with, since a componentRef alone can't distinguish one instance's data from another's."
  );

const perInstanceDataSchema = z
  .record(z.string(), z.array(z.record(z.string(), z.unknown())))
  .optional()
  .describe(
    'Preferred alternative to instanceOverrides: raw per-instance field data, keyed by component name, one array entry per rendered instance in document order — e.g. { "StatCard": [{"label":"Sessions this week","value":"12","tone":"neutral"}, {"label":"Avg. speaking score","value":"6.8","tone":"success"}, {"label":"Missed sessions","value":"1","tone":"warning"}] }. This is the exact shape inspect_component_dependency_tree\'s mappedDataRefs already yields (its dataSources[].items) — no translation into instanceOverrides\' {path, characters} structure required. This tool resolves each field to its captured text node\'s path and matches instances to array entries automatically; problems doing so (a component name with no match, an item-count mismatch, a field that never matches any captured text) come back in instanceOverrideWarnings rather than failing the merge or silently producing no overrides. Values that are neither string, number, nor boolean are ignored.'
  );

const projectRootSchema = z
  .string()
  .optional()
  .describe("Overrides the server's default project root for this call only. Usually omit this — see the README's project-root resolution order.");

/**
 * Registers every reactfig tool on an already-constructed McpServer.
 * Split out from main() so tests can exercise the real MCP dispatch path
 * (zod input validation, the actual registered handlers) over a real
 * Client/Server transport, instead of calling tool implementations
 * in-process and skipping the MCP boundary entirely.
 */
export function registerTools(server: McpServer, deps: { provider: ModelProvider; state: ProjectRootState }) {
  const { provider, state } = deps;
  const viewportSchema = z.object({ name: z.string(), width: z.number(), height: z.number() });
  // Live Interactive Capture sessions (an open browser page + its
  // CollectionSession), keyed by collectionId, for the lifetime of this
  // server process — see start_interactive_capture's doc comment. A
  // collection's persisted manifest (on disk) remains the durable source
  // of truth regardless of what's in this map; it only lets
  // get_interactive_capture_status/finalize_interactive_capture reach an
  // already-open browser page instead of just reading the manifest back.
  const activeInteractiveSessions = new Map<string, { session: CollectionSession; browser: InteractiveBrowserHandle }>();
  // Agent Continuation (docs/adr/0027 section 19) — one shared instance
  // for the server process's whole lifetime, same "one instance, many
  // collections" shape as activeInteractiveSessions above; see
  // collection/continuation.ts's own doc comment for what this can and
  // can't do.
  const continuationBridge = new ContinuationBridge();

  server.registerTool(
    "inspect_component_source",
    {
      description:
        "Inspect a React component's source via static AST analysis only — resolved prop types, variant-axis candidates, JSX composition, imported sub-components. No browser, no model. Useful for a quick check before running generate_design_ir.",
      inputSchema: { sourceFile: z.string(), exportName: z.string().optional(), projectRoot: projectRootSchema },
    },
    withToolLogging("inspect_component_source", async (args) => {
      return toResult(await inspectComponentSourceTool(args, { projectRoot: resolveProjectRoot(args.projectRoot, state) }));
    })
  );

  server.registerTool(
    "inspect_component_dependency_tree",
    {
      description:
        "Like inspect_component_source, but walks the full nested composition tree instead of stopping at one import hop — e.g. Dashboard -> SessionCard -> Avatar/Badge/Button in one call, not one inspect_component_source call per level. Returns every component reached (deduplicated by file, with its own direct importedComponents, its hop count `depth` from the entry, and `mappedDataRefs`: any `.map()` list-rendering patterns found in that component's own file, with the backing const array's parsed items — e.g. Dashboard's `STATS.map((stat) => <StatCard {...stat} />)` — so a caller can auto-discover per-instance data instead of every repeated instance rendering identical content), plus `unresolved`: imported JSX tags that never resolved to project source at all (external packages like icon libraries) — these can never be satisfied by generating more checkpoints, unlike a name simply not generated yet. Use this before merge_design_ir_checkpoints on a composite component to know up front which nested components need their own generate_design_ir + checkpoint first, rather than discovering a missing one only after the merge reports an unresolved external ref.",
      inputSchema: {
        sourceFile: z.string().describe("Path to the entry .tsx file, relative to projectRoot (or absolute) — e.g. a screen/page component like Dashboard.tsx."),
        exportName: z.string().optional().describe("Which exported component to start from in sourceFile. If omitted, the first capitalized named export is used."),
        maxDepth: z.number().optional().describe("How many import hops to follow from the entry component. Default 8."),
        projectRoot: projectRootSchema,
      },
    },
    withToolLogging("inspect_component_dependency_tree", async (args) => {
      return toResult(await inspectComponentDependencyTreeTool(args, { projectRoot: resolveProjectRoot(args.projectRoot, state) }));
    })
  );

  server.registerTool(
    "find_component_selector",
    {
      description:
        'Discover a specific, ready-to-use CSS selector for a component before calling generate_design_ir — avoids guessing a selector (e.g. a class name or bare tag) that might resolve to the wrong element, or to more than one. Navigates to `url` and returns every element on the page that is genuinely the root of an instance of `componentName` (its own React ownership boundary, not merely "somewhere inside" it), each with a selector that resolves to exactly that element, a short text preview, and its bounding box — enough to tell multiple instances apart (e.g. which of several SessionCards\' Avatar you want) without a screenshot. Returns zero matches, not an error, when the component isn\'t rendered on this page/route right now.',
      inputSchema: {
        url: z.string().describe("The running dev server URL to navigate to."),
        componentName: z.string().describe("The React component displayName/function name to find — same value generate_design_ir's componentName expects."),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Defaults to 1440x900."),
      },
    },
    withToolLogging("find_component_selector", async (args) => {
      const findInstances = createPlaywrightFindSelector({ storageStatePath: process.env.REACTFIG_STORAGE_STATE });
      return toResult(await findComponentSelectorTool(args, { findInstances }));
    })
  );

  server.registerTool(
    "generate_design_ir",
    {
      description:
        "Run the full pipeline for one component: capture its rendered evidence from a running dev server, inspect its source, and use the configured model to produce a validated design-ir/v1 document. Handles browser inspection, evidence assembly, and AI reasoning internally — call this once per component, not a sequence of lower-level steps. Can take well over a minute against a real browser and a local model — if your MCP client supports progress-based timeout extension, send a progressToken; see docs/adr/0013-generate-design-ir-timeout.md if you see 'Request timed out' regardless.",
      inputSchema: {
        sourceFile: z.string().describe("Path to the .tsx source file, relative to the project root."),
        exportName: z.string().optional(),
        componentName: z.string().optional().describe("Defaults to the AST-detected export name."),
        url: z.string().describe("The running dev server URL where the component is rendered."),
        selector: z.string().describe("CSS selector for the component's root DOM node."),
        prompt: z
          .string()
          .optional()
          .describe(
            "Optional free-text guidance appended to the model's interpretation prompt, e.g. 'focus on the avatar's status-dot overlay and badge styling'. Does not change what evidence is captured — only how it's interpreted. To capture multiple visual states (e.g. completed/scheduled/missed), use `variants`, not this field."
          ),
        viewports: z.array(viewportSchema).optional().describe('Defaults to a single 1440x900 "desktop" viewport. First entry is the default capture.'),
        variants: z
          .array(
            z.object({
              propValues: z.record(z.string(), z.unknown()),
              url: z.string().optional(),
              selector: z.string().optional(),
              viewport: viewportSchema.optional(),
            })
          )
          .optional()
          .describe("Additional prop-combination captures, e.g. different Storybook controls or routes."),
        maxRepairAttempts: maxRepairAttemptsSchema,
        maxToolIterations: maxToolIterationsSchema,
        projectRoot: projectRootSchema,
      },
    },
    withToolLogging("generate_design_ir", async (args, extra) => {
      debugLog("generate_design_ir: request id", { requestId: extra.requestId });
      const projectRoot = resolveProjectRoot(args.projectRoot, state);
      debugLog("project root resolved", { projectRoot });
      const captureComponent = createPlaywrightCapture({
        storageStatePath: process.env.REACTFIG_STORAGE_STATE,
        screenshotDir: join(projectRoot, ".reactfig", "screenshots"),
      });
      const onProgress = makeProgressReporter(extra.sendNotification, extra._meta?.progressToken);
      return toResult(
        await generateDesignIrTool(args, {
          projectRoot,
          provider,
          captureComponent,
          signal: extra.signal,
          onProgress,
        })
      );
    })
  );

  server.registerTool(
    "start_interactive_capture",
    {
      description:
        'Opens a real browser against a running dev server for Interactive Capture Mode, with a floating "ReactFig" overlay already present: the developer takes over from there — logging in, navigating, reaching whatever page/application state they want — and, at any point, turns on selection mode and clicks elements to capture them (DevTools-style hover highlight, then a preview with Confirm/Parent/Child/Cancel). This call returns as soon as the browser is attached; it does NOT wait for the developer to finish. Poll get_interactive_capture_status to check progress, and call finalize_interactive_capture once the developer is done selecting. Existing generate_design_ir usage (a known url + selector) is completely unaffected by this — Interactive Capture is a separate, explicitly opt-in entry point for when the developer wants to pick elements visually instead.',
      inputSchema: {
        url: z.string().optional().describe("The running dev server URL to open. Required when starting a new collection; omit when resuming via collectionId."),
        collectionId: z.string().optional().describe("Resume a previously started, not-yet-finalized collection (e.g. after a browser crash or a restarted OpenCode/Claude Code process) instead of starting a new one."),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Browser viewport size for this session. Defaults to 1440x900 — set this to interactively capture a responsive/mobile layout instead of desktop."),
        defaultOutputFormat: z
          .enum(["rfd", "json", "svg", "html"])
          .optional()
          .describe(
            'Output Intent (docs/architecture.md) — the collection-level default output format every selection exports as unless it picks its own override in the overlay\'s output picker. Omit to keep the backward-compatible default: "rfd" wherever nothing else specifies a format. Ignored when resuming an existing collectionId.'
          ),
        projectRoot: projectRootSchema,
      },
    },
    withToolLogging("start_interactive_capture", async (args) => {
      const projectRoot = resolveProjectRoot(args.projectRoot, state);
      return toResult(
        await startInteractiveCaptureTool(args, {
          projectRoot,
          attachBrowser: (session, options) => attachInteractiveBrowser(session, options),
          continuationBridge,
          registerActiveSession: (collectionId, entry) => activeInteractiveSessions.set(collectionId, entry),
          dropActiveSession: (collectionId) => activeInteractiveSessions.delete(collectionId),
          storageStatePath: process.env.REACTFIG_STORAGE_STATE,
        })
      );
    })
  );

  server.registerTool(
    "get_interactive_capture_status",
    {
      description:
        "Read-only status check for an Interactive Capture collection started with start_interactive_capture — current lifecycle status, and every selection captured so far (including removed/failed ones, for an honest log). Safe to call repeatedly while the developer is still browsing/selecting; never blocks waiting for them to do anything.",
      inputSchema: { collectionId: z.string(), projectRoot: projectRootSchema },
    },
    withToolLogging("get_interactive_capture_status", async (args) => {
      return toResult(
        await getInteractiveCaptureStatusTool(args, {
          projectRoot: resolveProjectRoot(args.projectRoot, state),
          getActiveSession: (collectionId) => activeInteractiveSessions.get(collectionId),
        })
      );
    })
  );

  server.registerTool(
    "finalize_interactive_capture",
    {
      description:
        'Marks an Interactive Capture collection COMPLETE: after this call, the persisted collection — not the live browser — is the source of truth, and the browser can be closed (default: this call closes it automatically) without affecting anything downstream. Returns the finalized manifest plus the list of usable selections, each ready to pass as `selectionId` to generate_design_ir_from_capture. No new selections can be added to a collection once finalized — start a fresh collection instead.',
      inputSchema: {
        collectionId: z.string(),
        closeBrowser: z.boolean().optional().describe("Close the attached browser once finalized. Default true."),
        projectRoot: projectRootSchema,
      },
    },
    withToolLogging("finalize_interactive_capture", async (args) => {
      return toResult(
        await finalizeInteractiveCaptureTool(args, {
          projectRoot: resolveProjectRoot(args.projectRoot, state),
          getActiveSession: (collectionId) => activeInteractiveSessions.get(collectionId),
          dropActiveSession: (collectionId) => activeInteractiveSessions.delete(collectionId),
        })
      );
    })
  );

  server.registerTool(
    "generate_design_ir_from_capture",
    {
      description:
        `Like generate_design_ir, but sources its evidence from one selection of a finalized Interactive Capture collection instead of a live url/selector — the browser does not need to be open for this call. Runs the exact same pipeline (source inspection, AI interpretation, Design IR construction, checkpointing) as generate_design_ir; only where the DOM/screenshot evidence comes from differs. The collection must be finalized first (finalize_interactive_capture) — this deliberately never reads from an in-progress collection, so the pipeline never has a hidden dependency on a browser session that might still be open or might have crashed. sourceFile is optional (docs/adr/0027, "Source-less Design IR Generation"): omit it entirely to generate a Design IR from the captured DOM/CSS/screenshot evidence ALONE, with no React source involved at all — useful when capturing a page you don't have the source for. The result's outputFormat is resolved from this selection's own persisted Output Intent (its own picked format, else the collection's default, else "rfd") — pass it straight through to export_design_output.`,
      inputSchema: {
        collectionId: z.string(),
        selectionId: z.string().describe("One selection's id from finalize_interactive_capture's or get_interactive_capture_status's result."),
        sourceFile: z
          .string()
          .optional()
          .describe(
            "Path to the .tsx source file, relative to the project root. Optional — omit for source-less generation (docs/adr/0027): the selection's own persisted capture evidence is used instead, no React source required. When omitted, componentName is recommended (falls back to the selection's own recorded component name otherwise)."
          ),
        exportName: z.string().optional(),
        componentName: z.string().optional().describe("Defaults to the AST-detected export name when sourceFile is given, or the selection's own recorded component name when it's omitted."),
        prompt: z.string().optional().describe("Optional free-text guidance appended to the model's interpretation prompt — same as generate_design_ir's `prompt`."),
        maxRepairAttempts: maxRepairAttemptsSchema,
        maxToolIterations: maxToolIterationsSchema,
        projectRoot: projectRootSchema,
      },
    },
    withToolLogging("generate_design_ir_from_capture", async (args, extra) => {
      debugLog("generate_design_ir_from_capture: request id", { requestId: extra.requestId });
      const projectRoot = resolveProjectRoot(args.projectRoot, state);
      const onProgress = makeProgressReporter(extra.sendNotification, extra._meta?.progressToken);
      return toResult(
        await generateDesignIrFromCaptureTool(args, {
          projectRoot,
          provider,
          signal: extra.signal,
          onProgress,
        })
      );
    })
  );

  server.registerTool(
    "export_design_artifact",
    {
      description:
        'Package a validated Design IR document into a portable .rfd artifact and write it to disk. Accepts EITHER `document` (typically generate_design_ir\'s output, pasted inline) OR `checkpointRef` (e.g. "SessionCard@v3", "SessionCard@latest") to read the document straight from that checkpoint on disk instead — exactly one of the two is required. Prefer `checkpointRef` when a checkpoint already exists (the normal case, since generate_design_ir always writes one): it avoids ever needing to reproduce a full Design IR document as a tool-call argument, which is a common source of transport/argument-size errors for larger documents. Defaults to "design/<document name>.rfd" under the project root if outputPath is omitted. Attempts to fetch http(s) asset references automatically; unresolved assets are recorded honestly rather than failing the export.',
      inputSchema: {
        document: z
          .unknown()
          .optional()
          .describe("A design-ir/v1 DesignDocument, e.g. generate_design_ir's `document` field. Omit this and supply `checkpointRef` instead when a checkpoint already exists — see that field."),
        outputPath: z
          .string()

          .optional()
          .describe('Where to write the .rfd file, relative to the project root, or absolute. Defaults to "design/<document name>.rfd".'),
        fetchAssets: z.boolean().optional().describe("Attempt to fetch http(s) asset references automatically. Default true."),
        checkpointRef: z
          .string()
          .optional()
          .describe(
            'Either the SOURCE of the document (when `document` is omitted — reads straight from this checkpoint, e.g. "SessionCard@v3" or "SessionCard@latest") or, when `document` IS given, purely a bookkeeping hint: marks that checkpoint\'s manifest "export" stage completed and updates checkpoint-map.json after a successful export, with no effect on the exported artifact itself. Either way, a successful export always updates this checkpoint\'s bookkeeping when checkpointRef is given.'
          ),
        projectRoot: projectRootSchema,
      },
    },
    withToolLogging("export_design_artifact", async (args) => {
      const projectRoot = resolveProjectRoot(args.projectRoot, state);

      // MCP boundary: `args.document` is whatever the client put in the
      // CallTool request's `arguments.document` field. request.params.arguments
      // is already-parsed JSON by the time it gets here (the SDK's transport
      // decodes the JSON-RPC envelope), but that only guarantees `document`
      // is *some* JSON value — not that it's an object. A client that forwards
      // generate_design_ir's result verbatim (its `content[0].text` is itself
      // a JSON string, per toResult()) rather than re-parsing it first will
      // hand us that JSON as a *string*, and `for (const asset of
      // document.assets)` then fails with "not iterable" instead of a useful
      // error. Normalize exactly once, here, then force a full
      // serialize→deserialize round-trip before validation and export.
      let rawDocument: unknown = args.document;

      // No `document` supplied — source it straight from a checkpoint
      // instead of requiring the caller to reproduce it inline (see this
      // tool's description). Reuses the exact same read
      // merge_design_ir_checkpoints already does for each of its own
      // inputs (resolveCheckpointRef + readValidatedDesignIr) rather than
      // duplicating it, and sidesteps the transport/argument-size failure
      // class a large inline `document` can hit.
      if (rawDocument === undefined) {
        if (!args.checkpointRef) {
          throw new Error("export_design_artifact: supply either `document` or `checkpointRef` (got neither).");
        }
        const sourceDir = await resolveCheckpointRef(projectRoot, args.checkpointRef);
        rawDocument = await readValidatedDesignIr(sourceDir);
        debugLog("export_design_artifact: document sourced from checkpoint", { checkpointRef: args.checkpointRef, path: sourceDir.path });
      }

      debugLog("export_design_artifact: document received", {
        typeofDocument: typeof rawDocument,
        typeofAssets: typeof (rawDocument as { assets?: unknown })?.assets,
        assetsIsArray: Array.isArray((rawDocument as { assets?: unknown })?.assets),
      });

      // Step 1: if a client forwarded a JSON *string*, parse it to an object
      // first (normalizeDocumentArg). Step 2: force the explicit
      // serialize→deserialize round-trip so export consumes a reconstructed
      // object, never an in-memory reference from a prior call (PROMPT.md §3).
      const normalized = normalizeDocumentArg(rawDocument, "export_design_artifact: `document`");
      if (typeof rawDocument === "string") {
        debugLog("export_design_artifact: document was a JSON string, parsed", {
          typeofAssets: typeof (normalized as { assets?: unknown }).assets,
          assetsIsArray: Array.isArray((normalized as { assets?: unknown }).assets),
        });
      }
      const document = roundTripDocument(normalized, "export_design_artifact: `document`");

      // Fail fast with a real design-ir/v1 validation error (e.g. "assets:
      // must be array") rather than letting a malformed document reach the
      // asset-fetch loop and throw a raw TypeError. This is the "validate
      // after reading" step (PROMPT.md §4): the checkpoint-reconstructed /
      // round-tripped document must pass the existing validator before export.
      assertDesignIR(document);

      debugLog("artifact generation started");
      const result = toResult(
        await exportDesignArtifactTool({ ...(args as Parameters<typeof exportDesignArtifactTool>[0]), document }, { projectRoot })
      );
      debugLog("artifact generation finished");

      // Optional bookkeeping only (ADR 0017): if the caller told us which
      // checkpoint this document came from, record that its export stage
      // completed. A missing/unresolvable checkpointRef is a bookkeeping
      // miss, not an export failure — the artifact was already written
      // successfully above, so this never throws back to the caller.
      if (args.checkpointRef) {
        try {
          const dir = await resolveCheckpointRef(projectRoot, args.checkpointRef);
          const existing = await readManifest(dir);
          if (existing) {
            const patched = await patchManifest(dir, { stages: { export: "completed" } }, existing);
            await upsertCheckpointMapEntry(projectRoot, patched, dir);
          }
        } catch (err) {
          debugLog("export_design_artifact: checkpointRef bookkeeping skipped", {
            checkpointRef: args.checkpointRef,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return result;
    })
  );

  server.registerTool(
    "export_design_output",
    {
      description:
        'General "produce a requested output" version of export_design_artifact — Output Intent\'s Renderer/Exporter step (docs/architecture.md): "Design IR -> Output selection -> Renderer/Exporter". Same `document`/`checkpointRef` input contract as export_design_artifact. `format` defaults to "rfd" (same backward-compatible default export_design_artifact always had) and, for "rfd", produces byte-identical output to it — this tool is a superset, not a replacement; export_design_artifact keeps working unchanged for existing prompts/clients that already call it directly. "json" writes the canonical Design IR as deterministic JSON; "svg"/"html" render a static visual export of the root component (or a chosen variant) — see @reactfig/artifact\'s renderSvg/renderHtml doc comments for exactly what visual fidelity to expect.',
      inputSchema: {
        document: z.unknown().optional().describe("A design-ir/v1 DesignDocument. Omit and supply `checkpointRef` instead when a checkpoint already exists."),
        format: z.enum(["rfd", "json", "svg", "html"]).optional().describe('Output Intent — which format to produce. Defaults to "rfd".'),
        outputPath: z
          .string()
          .optional()
          .describe('Where to write the file, relative to the project root, or absolute. Defaults to "design/<document name>.<extension for format>".'),
        fetchAssets: z.boolean().optional().describe('Only consulted when format is "rfd" — see export_design_artifact\'s `fetchAssets`. Default true.'),
        checkpointRef: z
          .string()
          .optional()
          .describe('Source the document from this checkpoint instead of `document` (e.g. "SessionCard@v3", "SessionCard@latest"), same as export_design_artifact\'s `checkpointRef`.'),
        projectRoot: projectRootSchema,
      },
    },
    withToolLogging("export_design_output", async (args) => {
      const projectRoot = resolveProjectRoot(args.projectRoot, state);

      let rawDocument: unknown = args.document;
      if (rawDocument === undefined) {
        if (!args.checkpointRef) {
          throw new Error("export_design_output: supply either `document` or `checkpointRef` (got neither).");
        }
        const sourceDir = await resolveCheckpointRef(projectRoot, args.checkpointRef);
        rawDocument = await readValidatedDesignIr(sourceDir);
      }

      const normalized = normalizeDocumentArg(rawDocument, "export_design_output: `document`");
      const document = roundTripDocument(normalized, "export_design_output: `document`");
      assertDesignIR(document);

      const result = toResult(
        await exportDesignOutputTool({ ...(args as Parameters<typeof exportDesignOutputTool>[0]), document }, { projectRoot })
      );

      if (args.checkpointRef) {
        try {
          const dir = await resolveCheckpointRef(projectRoot, args.checkpointRef);
          const existing = await readManifest(dir);
          if (existing) {
            const patched = await patchManifest(dir, { stages: { export: "completed" } }, existing);
            await upsertCheckpointMapEntry(projectRoot, patched, dir);
          }
        } catch (err) {
          debugLog("export_design_output: checkpointRef bookkeeping skipped", {
            checkpointRef: args.checkpointRef,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return result;
    })
  );

  server.registerTool(
    "merge_design_ir_documents",
    {
      description:
        "Combine a primary Design IR document (e.g. a SessionCard from generate_design_ir) with one or more dependency documents for the nested components it references (e.g. Avatar, Badge, Button — each generated separately, pointed at that component's own source file). Resolves the primary's `external:<Name>` placeholder refs (generate_design_ir's documented per-call limitation: it never resolves a nested component's own definition, only flags where one belongs) to the real component from a matching dependency, and folds all components/assets into one document ready for export_design_artifact. Without this step, an artifact's nested component instances render as blank placeholder boxes in Figma, since their componentId points at nothing in that artifact. Any `external:<Name>` ref with no matching dependency is left as-is and listed in the result's `unresolvedExternalRefs` — still renders as a placeholder, but now you know exactly which component is missing.",
      inputSchema: {
        primary: z.unknown().describe("The outer document, e.g. generate_design_ir's `document` field for the composite component (SessionCard)."),
        dependencies: z.array(z.unknown()).describe("One document per nested component referenced by the primary (e.g. Avatar, Badge, Button), each generate_design_ir's `document` field for that component."),
        instanceOverrides: instanceOverridesSchema,
      },
    },
    withToolLogging("merge_design_ir_documents", async (args) => {
      const primary = normalizeDocumentArg(args.primary, "merge_design_ir_documents: `primary`");
      assertDesignIR(primary);

      const dependencies = args.dependencies.map((dep, i) => {
        const normalized = normalizeDocumentArg(dep, `merge_design_ir_documents: \`dependencies[${i}]\``);
        assertDesignIR(normalized);
        return normalized;
      });

      return toResult(
        await mergeDesignIrDocumentsTool({ primary, dependencies, instanceOverrides: args.instanceOverrides } as Parameters<typeof mergeDesignIrDocumentsTool>[0])
      );
    })
  );

  server.registerTool(
    "merge_design_ir_checkpoints",
    {
      description:
        'Checkpoint-native version of merge_design_ir_documents: merges a primary component\'s design-ir checkpoint with one or more dependency checkpoints by reference (a component name, resolving its latest version, or "Name@vN" for a specific historical version — the checkpointRef every generate_design_ir/merge_design_ir_checkpoints result returns) instead of requiring the full JSON documents as inline tool-call arguments. Resolves external:<Name> nested-instance refs the same way merge_design_ir_documents does, persists the merged document as its own versioned checkpoint with a manifest recording exactly which input refs it merged, and — unless exportArtifact is false — packages it directly into a .rfd artifact in the same call. Use this over merge_design_ir_documents + export_design_artifact whenever the inputs already exist as checkpoints: it takes a set of component checkpoints (one primary, any number of dependencies, simple or deeply nested) all the way to a final .rfd on disk in a single call, with no client-side JSON plumbing and no external script/shell/model tool-calling loop needed to glue the steps together. When the primary has repeated template instances from a `.map()` (e.g. three StatCards), pass their real per-instance data via `perInstanceData` — built directly from inspect_component_dependency_tree\'s `mappedDataRefs` — rather than hand-building `instanceOverrides`; check the returned `instanceOverrideWarnings` to confirm it actually found and applied that data rather than assuming a non-error response means it did.',
      inputSchema: {
        primaryCheckpointId: z
          .string()
          .describe('Checkpoint reference for the outer/composite component: a component name (latest version), "Name@latest", or "Name@vN" for a specific version — e.g. SessionCard\'s checkpointRef.'),
        dependencyCheckpointIds: z
          .array(z.string())
          .describe(
            "Checkpoint references for the nested components the primary references, same syntax as primaryCheckpointId — e.g. Avatar/Badge/Button's checkpoints. May be left empty (`[]`) when reuseExistingCheckpoints is enabled (the default) and you want to rely entirely on auto-discovery against existing checkpoints; otherwise at least one reference is required."
          ),
        mergedCheckpointId: z
          .string()
          .optional()
          .describe("Component name to persist the merged document's checkpoint under. Defaults to `merged-<primary component name>`."),
        exportArtifact: z.boolean().optional().describe("Package the merged document into a .rfd artifact in the same call. Default true."),
        outputPath: z
          .string()
          .optional()
          .describe('Where to write the .rfd file when exportArtifact is true, relative to the project root, or absolute. Defaults to "design/<document name>.rfd".'),
        fetchAssets: z.boolean().optional().describe("Attempt to fetch http(s) asset references automatically when exporting. Default true."),
        reuseExistingCheckpoints: z
          .boolean()
          .optional()
          .describe(
            "After merging the explicit dependencyCheckpointIds, automatically resolve any remaining unresolved external:<Name> refs against checkpoints that already exist on disk for that component name (e.g. from an earlier generate_design_ir run), folding them in without needing to be re-listed by hand. Repeats until nothing new is found, so nested dependencies of an auto-resolved checkpoint are picked up too. Never generates anything — a name with no matching checkpoint stays in unresolvedExternalRefs. Default true."
          ),
        instanceOverrides: instanceOverridesSchema,
        perInstanceData: perInstanceDataSchema,
        projectRoot: projectRootSchema,
      },
    },
    withToolLogging("merge_design_ir_checkpoints", async (args) => {
      return toResult(
        await mergeDesignIrCheckpointsTool(args as Parameters<typeof mergeDesignIrCheckpointsTool>[0], { projectRoot: resolveProjectRoot(args.projectRoot, state) })
      );
    })
  );

  server.registerTool(
    "validate_design_ir",
    {
      description:
        "Validate an arbitrary document against the design-ir/v1 schema. A debugging/inspection tool — generate_design_ir and export_design_artifact already validate internally as part of the normal pipeline; use this only to check a document you constructed or edited by hand.",
      inputSchema: { document: z.unknown() },
    },
    withToolLogging("validate_design_ir", async (args) => toResult(await validateDesignIrTool(args as Parameters<typeof validateDesignIrTool>[0])))
  );

  server.registerTool(
    "diff_design_ir",
    {
      description:
        'Semantically compare two design-ir/v1 documents and report every meaningful difference — bounds, typography, fills/strokes/effects, added/removed nodes or components, componentRef/instance changes, variant axis changes, page/asset changes — id-matched, never index-matched, so a node that simply moved position is not misreported as removed+added. NOT a generic JSON diff: key-order and other non-semantic noise (e.g. meta.generatedAt, which differs on every generation) is never reported. Give each side as EITHER an inline document (`before`/`after`) OR a checkpoint reference (`beforeCheckpoint`/`afterCheckpoint` — a component name for its latest version, "Name@latest", or "Name@vN" for a specific historical version, e.g. from checkpoint versioning: "SessionCard@v1" vs "SessionCard@v2") — mixing both or neither for the same side is an error. Checkpoint references are resolved and read directly from .reactfig/checkpoints/, so comparing two checkpoint versions never requires pasting either document\'s JSON inline. Returns structured `entries` (category/path/before/after/change/severity) for programmatic use, plus a human-readable grouped `report` string.',
      inputSchema: {
        before: z.unknown().optional().describe("Inline 'before' document. Give exactly one of `before` or `beforeCheckpoint`."),
        after: z.unknown().optional().describe("Inline 'after' document. Give exactly one of `after` or `afterCheckpoint`."),
        beforeCheckpoint: z.string().optional().describe('Checkpoint reference for the "before" side: a component name (latest version), "Name@latest", or "Name@vN".'),
        afterCheckpoint: z.string().optional().describe('Checkpoint reference for the "after" side, same syntax as beforeCheckpoint.'),
        title: z.string().optional().describe("Optional title for the rendered `report` string. Defaults to a description built from the resolved checkpoint refs or document names."),
        projectRoot: projectRootSchema,
      },
    },
    withToolLogging("diff_design_ir", async (args) => {
      const projectRoot = resolveProjectRoot(args.projectRoot, state);
      const beforeArg = args.before !== undefined ? roundTripDocument(normalizeDocumentArg(args.before, "diff_design_ir: `before`"), "diff_design_ir: `before`") : undefined;
      const afterArg = args.after !== undefined ? roundTripDocument(normalizeDocumentArg(args.after, "diff_design_ir: `after`"), "diff_design_ir: `after`") : undefined;
      if (beforeArg !== undefined) assertDesignIR(beforeArg);
      if (afterArg !== undefined) assertDesignIR(afterArg);
      return toResult(
        await diffDesignIrTool(
          { before: beforeArg, after: afterArg, beforeCheckpoint: args.beforeCheckpoint, afterCheckpoint: args.afterCheckpoint, title: args.title },
          { projectRoot }
        )
      );
    })
  );
}

async function main() {
  debugLog("MCP server starting", { debug: true });
  const state: ProjectRootState = { explicit: resolveExplicitRoot(process.argv, process.env) };
  const provider = createProviderFromEnv();
  debugLog("model provider configured", { provider: provider.name, vision: provider.capabilities.vision, toolCalling: provider.capabilities.toolCalling });

  const server = new McpServer({ name: "reactfig", version: "0.1.0" });
  registerTools(server, { provider, state });

  await server.connect(new StdioServerTransport());
  debugLog("MCP server connected");

  // Project-root resolution priority 3 (see projectRoot.ts): ask the
  // client for its workspace root via the MCP `roots` protocol feature.
  // Capabilities are only known once the initialize handshake (part of
  // connect()) has completed, so this must happen after connect, not
  // before — and it must never block startup or crash the server if the
  // client doesn't support it (most don't yet).
  try {
    const capabilities = server.server.getClientCapabilities();
    if (capabilities?.roots) {
      const { roots } = await server.server.listRoots();
      const first = roots[0];
      if (first?.uri) {
        state.clientRoot = fileURLToPath(first.uri);
        debugLog("client roots/list resolved", { clientRoot: state.clientRoot });
      }
    }
  } catch {
    // Client advertised roots support but the request failed, or didn't
    // advertise it at all — falls through to --project/cwd. Not fatal.
  }
}

// Only run main() when this file is executed directly (`node dist/server.js`
// / the package's bin entry) — not when it's imported for its exports (e.g.
// `registerTools` from tests). Without this guard, importing this module at
// all unconditionally starts the real server, including reading real env
// vars for the model provider and — had it gotten that far — connecting a
// StdioServerTransport that reads real stdin.
const isMainModule = process.argv[1] ? import.meta.url === `file://${process.argv[1]}` : false;
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}