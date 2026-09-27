# @reactfig/mcp

A thin MCP adapter over the existing pipeline — `@reactfig/analyzer`
(inspection + AI orchestration), `@reactfig/model` (the configured
provider), and `@reactfig/artifact` (`.rfd` packaging). This package
contains no analyzer, AI, IR-construction, validation, or artifact logic
of its own; every tool is composition over an existing exported function
from those packages. See `docs/adr/0010-mcp-adapter.md` for the design
review and decisions.

```
Claude Code / another MCP client
        │  generate_design_ir  (once per component — primary, then each nested one)
        ▼
ReactFig MCP  ──────────────────►  @reactfig/analyzer (capture + AST + evidence)
        │                          @reactfig/model (configured provider)
        │                          @reactfig/analyzer/ai (interpret + buildDesignIR)
        ▼
  validated Design IR, persisted as .reactfig/checkpoints/<component>/v<N>/
  (per component; nested refs left as `external:<n>` placeholders)
        │  merge_design_ir_documents        (client already holds each document in memory)
        │    — or —
        │  merge_design_ir_checkpoints      (client only has each component's checkpoint
        │                                    reference, e.g. "SessionCard@v2" — only
        │                                    needed if there ARE nested components)
        ▼
  one merged, fully-resolved Design IR (persisted as its own versioned checkpoint too)
        │  export_design_artifact           (merge_design_ir_checkpoints does this step for
        │                                     you automatically unless exportArtifact: false)
        ▼
  @reactfig/artifact.pack()
        ▼
      .rfd

    Any two checkpoint versions — same component or different ones — can
    be compared directly with diff_design_ir, e.g. "SessionCard@v1" vs
    "SessionCard@v2", without pasting either document inline.
```

## Tools

Nine core tools — the smallest surface that exposes the pipeline (plus
four more, opt-in, for Interactive Capture Mode — see below) without
requiring a client to manually orchestrate low-level steps:

- **`generate_design_ir`** — the primary tool. Given a source file, a
  running dev-server URL, and a CSS selector, runs the full pipeline:
  browser capture → AST inspection → evidence assembly → AI orchestration
  → validated `design-ir/v1` document. Accepts optional `viewports` and
  `variants` to capture responsive states or specific prop combinations in
  one call. **Per-call limitation:** if the target component renders other
  components (e.g. `SessionCard` renders `Avatar`/`Badge`), it never
  resolves those nested components' own definitions — each becomes an
  `external:<n>` placeholder reference in the output. Generate each nested
  component separately (pointed at that component's own source file), then
  resolve the placeholders with `merge_design_ir_documents` below.
- **`find_component_selector`** — discovers a specific, ready-to-use CSS
  selector for a named component before calling `generate_design_ir`,
  instead of guessing one — navigates to a URL and returns every DOM
  element that is genuinely the root of an instance of that component
  (its own React ownership boundary), each with a selector, text preview,
  and bounding box.
- **`inspect_component_dependency_tree`** — like `inspect_component_source`
  below, but walks the full nested composition tree in one call (e.g.
  `Dashboard` → `SessionCard` → `Avatar`/`Badge`/`Button`), including
  `.map()`-based list-rendering data (`mappedDataRefs`) and which imports
  never resolved to project source at all.
- **`merge_design_ir_checkpoints`** — combines a primary component's
  checkpoint (e.g. `SessionCard`) with one checkpoint per nested
  dependency (e.g. `Avatar`, `Badge`, `Button`), each generated
  separately by its own `generate_design_ir` call, and resolves the
  primary's `external:<n>` placeholder refs (generate_design_ir's
  documented per-call limitation: it never resolves a nested component's
  own definition, only flags where one belongs) against a matching
  dependency. Takes `primaryCheckpointId` and `dependencyCheckpointIds`
  as checkpoint *references* — a component name for its latest version,
  `"Name@latest"`, or `"Name@vN"` for a specific historical version (the
  `checkpointRef` every `generate_design_ir` result returns) — reads each
  checkpoint's `design-ir.json` off disk itself, so the caller never has
  to reproduce a full document as a tool-call argument. Works just as
  well for a leaf component with no dependencies at all: leave
  `dependencyCheckpointIds` empty (the default `reuseExistingCheckpoints:
  true` just finds nothing extra to fold in) to use this as the general
  checkpoint → `.rfd` path even when there's nothing to merge. Persists
  the merged result as its own versioned checkpoint
  (`merged-<primary component name>` by default, with a manifest
  recording exactly which input refs it merged) for inspection, and —
  unless `exportArtifact: false` — packages it straight into a `.rfd` in
  the same call via `export_design_artifact`'s own logic. Any
  `external:<n>` ref with no matching dependency is left as-is and
  listed in the result's `unresolvedExternalRefs`, so you know exactly
  which component is still missing — without a matching dependency, that
  instance renders as a blank placeholder box in Figma. This is the
  recommended one-call path from a set of component checkpoints (simple
  or deeply nested, or even a single leaf) to a final artifact on disk:
  no client-side JSON plumbing, and no external script/shell/model
  tool-calling loop needed to glue merge and export together. See
  ADR 0016 and ADR 0017.
- **`export_design_artifact`** — packages a Design IR document into a
  portable `.rfd` and writes it to disk. Accepts EITHER `document`
  (typically `generate_design_ir`'s or `merge_design_ir_documents`'s
  output, pasted inline) OR `checkpointRef` (e.g. `"SessionCard@v3"`,
  `"SessionCard@latest"`) to read the document straight from that
  checkpoint instead — exactly one of the two is required. Prefer
  `checkpointRef` whenever a checkpoint already exists (the normal case,
  since `generate_design_ir` always writes one, and
  `merge_design_ir_checkpoints` above already does this internally for
  its own export step) — it avoids ever needing to reproduce a full
  Design IR document as a tool-call argument, which is a common source
  of transport/argument-size errors for larger documents. When
  `checkpointRef` is given (whether sourcing the document or, alongside
  an inline `document`, just identifying which checkpoint it came from),
  a successful export also marks that checkpoint's manifest `export`
  stage completed and updates `checkpoint-map.json` — a checkpoint that
  doesn't resolve never fails the export itself. Best-effort fetches
  `http(s)` asset references automatically.
- **`export_design_output`** — the general "produce a requested output"
  version of `export_design_artifact`, for Output Intent (see below and
  ADR 0027): same `document`/`checkpointRef` input contract, plus an
  optional `format` (`"rfd"` / `"json"` / `"svg"` / `"html"`, defaulting
  to `"rfd"`). For `"rfd"` it delegates straight to
  `export_design_artifact` — byte-identical output, so this is a
  superset, not a replacement; `export_design_artifact` itself is
  unchanged and keeps working exactly as before for any existing prompt
  that already calls it directly.
- **`merge_design_ir_documents`** — the inline-document counterpart to
  `merge_design_ir_checkpoints` above: same resolution semantics, but
  takes `primary` and `dependencies` as full documents pasted inline
  rather than checkpoint references. Since a checkpoint normally already
  exists for anything `generate_design_ir` has produced, reach for
  `merge_design_ir_checkpoints` first — this tool is here for a document
  that was hand-constructed or edited outside the checkpoint system (or
  a deployment that doesn't persist checkpoints at all), where there's
  nothing on disk to reference. Requires the caller to pass the full
  JSON of every document inline, which is more prone to
  transport/argument-size issues on larger documents than the
  checkpoint-reference path.
- **`diff_design_ir`** — semantically compares two `design-ir/v1`
  documents: bounds, typography, fills/strokes/effects, added/removed
  nodes or components, `componentRef`/instance changes, variant axis

  changes, page/asset changes — id-matched throughout, never
  index-matched, so a node that simply moved position is never
  misreported as removed+added. Not a generic JSON diff: non-semantic
  noise (key order, `meta.generatedAt`, which differs on every
  generation) is never reported. Give each side as either an inline
  document (`before`/`after`) or a checkpoint reference
  (`beforeCheckpoint`/`afterCheckpoint`, same syntax as
  `merge_design_ir_checkpoints`) — comparing two checkpoint versions,
  e.g. `"SessionCard@v1"` vs `"SessionCard@v2"`, is one call with two
  small strings, no document JSON pasted inline. Returns structured
  `entries`/`summary` for programmatic use plus a human-readable grouped
  `report` string. See ADR 0017.
- **`inspect_component_source`** — AST-only inspection (props,
  variant-axis candidates, JSX composition), no browser, no model. Useful
  as a quick standalone check.
- **`validate_design_ir`** — schema validation for an arbitrary document,
  kept as a debugging/inspection tool. Validation is already internal to
  the normal pipeline (`generate_design_ir` never returns an unvalidated
  document; `merge_design_ir_documents`/`export_design_artifact`/`pack()`
  validate again before packaging) — this tool exists for checking a
  document a client constructed or edited by hand, not as a required
  pipeline step.

### Interactive Capture Mode (optional, explicitly opt-in)

Four more tools, for when a component's exact rendered state is easier to
reach by hand than to describe up front — logging in, navigating to a
specific route, waiting on an API call, reaching a particular application
state — and you'd rather pick the target visually than guess a selector.
**None of this changes `generate_design_ir`'s normal behavior in any
way** — a client that never calls these four tools sees the server behave
exactly as before.

- **`start_interactive_capture`** — opens a real browser against a
  running dev server with a small floating "ReactFig" overlay already
  present, and returns immediately (it does not wait for you to finish).
  The developer takes over from there: log in, navigate freely, and turn
  on selection mode whenever ready to click something (DevTools-style
  hover highlight, then a preview with Confirm/↑ Parent/↓ Child/Cancel,
  and — since ADR 0027 — an output-format picker, see "Output Intent"
  below). An optional `defaultOutputFormat` sets the collection-wide
  default. Selections persist immediately on confirm — the browser is a
  capture surface, not something anything downstream depends on staying
  open.
- **`get_interactive_capture_status`** — read-only poll of a collection's
  current state: lifecycle status, every selection captured so far
  (including removed/failed ones, for an honest log), and (since ADR
  0027) `continuationPending`/`continuationSignaledAt` — whether the
  developer has clicked the overlay's own "Done / Continue" button yet.
  Safe to call repeatedly while the developer is still browsing.
- **`finalize_interactive_capture`** — marks a collection COMPLETE
  (closing its browser by default) and returns the usable selection list.
  After this point the persisted collection, not the browser, is the
  source of truth for everything downstream. The developer can also
  trigger the same finalization themselves from inside the browser, via
  the overlay's "Done / Continue" button (ADR 0027) — either path ends
  up in the same completed state.
- **`generate_design_ir_from_capture`** — the same pipeline as
  `generate_design_ir`, sourcing its evidence from one finalized
  selection instead of a live `url`/`selector`; the browser does not need
  to be open. Requires the collection to be finalized first. `sourceFile`
  is optional here too (ADR 0027, "Source-less Design IR Generation") —
  omit it to generate a Design IR from the captured DOM/CSS/screenshot
  evidence alone, no React source required. The result's `outputFormat`
  is resolved from this selection's own persisted Output Intent — pass it
  straight through to `export_design_output`.

See `docs/architecture.md`'s "Interactive Capture Mode" and "Output
Intent, source-less generation, and agent continuation" sections, and
ADR 0026/ADR 0027, for the full design, and the "What's tested here, and
what isn't" section below for current verification status.

## Checkpoint versioning, the checkpoint map, and resuming a session

Every `generate_design_ir`/`merge_design_ir_checkpoints` run persists to
`.reactfig/checkpoints/<component>/v<N>/` — a new run for the same
component never overwrites a previous one, so historical versions stay
available for `diff_design_ir` and for recovering from a stale checkpoint.
Each version directory has a small `manifest.json` (component, source
file + content hash + Git commit when available, which pipeline stages
completed, validation result) — enough to answer "what happened here"
without opening the larger `evidence.json`/`design-ir.json` files beside
it.

`.reactfig/checkpoint-map.json` is a small index over all of this, one
entry per component: latest version, source state, last completed stage,
validity. A new session resuming earlier work should read this file
*first* — it's plain JSON, no MCP tool call needed — rather than scanning
every checkpoint directory. If it's missing, stale, or looks wrong, any
tool call that touches checkpoints will keep working regardless (the map
is a disposable, regeneratable index, never the source of truth); a
future call to rebuild it programmatically is straightforward if needed,
via the exported `rebuildCheckpointMap` in `@reactfig/mcp`'s package API.

Staleness is a direct comparison: a checkpoint's manifest records the
source file's content hash at generation time; comparing that to a fresh
hash of the current file tells you whether the checkpoint still reflects
what's on disk. See ADR 0017 for the full design and its explicitly
simple (not dependency-graph-based) approach to this.

## Composite components

For a component that renders other components, the working sequence is:

1. `generate_design_ir` for the outer component (e.g. `SessionCard`).
2. `generate_design_ir` once for each nested component it references (e.g.
   `Avatar`, `Badge`) — each pointed at that component's own source file
   and its own rendered instance in the running app.
3. `merge_design_ir_documents` with the outer document as `primary` and
   the nested documents as `dependencies`.
4. `export_design_artifact` on the merged result.

Steps 3–4 collapse into **one call** if you already have each
component's checkpoint reference from step 1–2 (every `generate_design_ir`
result includes `checkpointRef`/`checkpointDir`/`checkpointVersion`): call
`merge_design_ir_checkpoints` with `primaryCheckpointId` set to the
outer component's reference and `dependencyCheckpointIds` set to the
nested components' references — it merges and exports the `.rfd` in one
tool call, with no need to re-read or re-pass any document JSON yourself.
This is the preferred sequence once checkpoints exist; use
`merge_design_ir_documents` + `export_design_artifact` as two separate
calls only when you're combining documents that don't already have
on-disk checkpoints (e.g. one you constructed by hand).

Once you have two versions of the same component's checkpoint (e.g. after
editing the source and re-running `generate_design_ir`), `diff_design_ir`
with `beforeCheckpoint: "SessionCard@v1"` and `afterCheckpoint:
"SessionCard@v2"` shows exactly what changed — useful both for reviewing a
redesign and for confirming a checkpoint you suspect is stale really did
change.

A capable MCP agent (Claude Code, OpenCode, or any other MCP client)
discovers all seven tools and their full descriptions the moment it
connects to this server — that's the MCP `tools/list` handshake, not
something this README controls. Given a prompt like "export SessionCard
to Figma," an agent that reads `generate_design_ir`'s own description
(which explicitly calls out the `external:<n>` limitation and points to
`merge_design_ir_documents`/`merge_design_ir_checkpoints`) can work out
this sequence on its own, without you spelling it out turn by turn. This
section exists so a human setting up or debugging the workflow has the
same sequence in one place — it doesn't change what the agent can
already discover from the tool metadata itself.

## Registering with an MCP client

```json
{
  "mcpServers": {
    "reactfig": {
      "command": "node",
      "args": ["node_modules/@reactfig/mcp/dist/server.js", "--project", "."],
      "env": {
        "REACTFIG_MODEL_PROVIDER": "openai-compatible",
        "REACTFIG_MODEL_BASE_URL": "http://localhost:11434/v1",
        "REACTFIG_MODEL_NAME": "qwen3.6"
      }
    }
  }
}
```

The project root is resolved once at startup (`--project <path>` or
`REACTFIG_PROJECT_ROOT`, falling back to `cwd`) — the server isn't
permanently bound to any one repository. Every tool call resolves
`sourceFile`/`outputPath` relative to that root.

## Model provider configuration

Configured once at server startup from environment variables (see
`src/providerConfig.ts`), not per tool call — tool arguments stay focused
on "which component," not "which model this time":

```bash
# Qwen 3.6 via Ollama (or any OpenAI-compatible endpoint)
REACTFIG_MODEL_PROVIDER=openai-compatible   # default, can be omitted
REACTFIG_MODEL_BASE_URL=http://localhost:11434/v1
REACTFIG_MODEL_NAME=qwen3.6
REACTFIG_MODEL_VISION=false                 # default; set true only if the pulled model actually supports it
REACTFIG_MODEL_TOOLS=true                   # default

# Anthropic
REACTFIG_MODEL_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-...
REACTFIG_MODEL_NAME=claude-sonnet-5
```

`REACTFIG_MODEL_BASE_URL` and `REACTFIG_MODEL_NAME` are required for
`openai-compatible` — there is deliberately no fallback base URL or model
name. An earlier version of this file defaulted a missing model name to
the literal string `"vision"`, which meant a misconfigured environment
would quietly try to talk to a nonexistent model instead of failing at
startup with a clear message. Get the config wrong now and you'll see
`createProviderFromEnv: ... requires REACTFIG_MODEL_BASE_URL and
REACTFIG_MODEL_NAME to be set` before the server ever accepts a tool
call, not a confusing failure mid-request.

`REACTFIG_MODEL_VISION=true` now genuinely does something: earlier
versions of `generate_design_ir` never captured a screenshot at all in
the real (non-test) pipeline, so this flag had no observable effect on
evidence quality regardless of its value — see ADR 0013. A screenshot is
now captured (into `<projectRoot>/.reactfig/screenshots/`) exactly when
this is `true`, and skipped entirely when it's `false`, since capturing
one costs real time inside a request that already has a tight wall-clock
budget (see "Slow or timing out?" below).

## Slow or timing out?

`generate_design_ir` does real browser work plus one or more model calls
per invocation and can legitimately take well over a minute against a
local model — see ADR 0013 for the full investigation of a real-world
`MCP error -32001: Request timed out` report. Two things help diagnose
and, for supporting clients, actually prevent it:

- **`REACTFIG_DEBUG=true`** — every pipeline stage (browser launch,
  navigation, selector wait, DOM snapshot, each model call with its
  duration, IR construction/validation, and more) writes one timestamped
  line to `stderr`, *and* to a file on disk — `REACTFIG_DEBUG_LOG_FILE`
  if set, otherwise `<os.tmpdir()>/reactfig-debug.log` by default (a real
  report showed no `stderr` output at all reaching the user through
  OpenCode's UI — the file is the reliable fallback; the first line
  logged in the process names the exact path). This is the fastest way
  to tell whether a slow call is stuck in the browser or spending its
  time on repeated model calls.
- **`maxToolIterations`/`maxRepairAttempts` are capped** (8 and 3
  respectively, defaults 5 and 2) — a higher value doesn't improve
  capture thoroughness (the model already sees the full DOM tree,
  computed styles, and any screenshot on its first turn) and directly
  multiplies wall-clock time; a real call with `maxToolIterations=15`
  was worst-case ~48 sequential model calls in one tool invocation. To
  capture multiple visual states (e.g. different card statuses), use the
  `variants` array, which drives deterministic re-capture, not a bigger
  iteration budget.
- **`prompt` is a real, honored parameter** — free-text guidance appended
  to the model's interpretation prompt (not evidence capture). An
  earlier version of the schema didn't define this field at all, so a
  client sending it got no error and no effect: Zod silently drops
  unrecognized keys by default.
- **MCP progress notifications** — if your MCP client sends a
  `progressToken` and honors `resetTimeoutOnProgress` on long-running
  tool calls (this is a client-side decision `@reactfig/mcp` cannot
  force), `generate_design_ir` sends `notifications/progress` at every
  stage, which can keep the client's own request timeout from expiring.
  Whether this actually prevents a timeout depends on your specific MCP
  client — see ADR 0013 for what's confirmed about OpenCode specifically
  (as of this writing, it doesn't yet support extending a tool-call
  timeout past its ~60s default, per upstream issues #8701/#8121/#23096
  — Claude Code's MCP client is confirmed to work correctly against
  long-running tools).

## Authenticated development apps

If the component you're capturing is behind a login (a dashboard, an app
shell that redirects to `/login` when unauthenticated), the MCP server
itself never handles credentials — the AI model is not in the login
loop, and no auth framework lives in this package. Instead, set
`REACTFIG_STORAGE_STATE` to a Playwright `storageState` JSON file
(cookies + `localStorage`) captured from an already-authenticated
session:

```bash
# One-time, interactively, using Playwright's own CLI — log in by hand
# in the window that opens, then save the session:
npx playwright open http://localhost:5174/login
# in the Playwright Inspector once you're logged in:
#   await context.storageState({ path: ".reactfig/auth.json" })

REACTFIG_STORAGE_STATE=.reactfig/auth.json
```

Every subsequent `generate_design_ir` call reuses that session for the
life of the MCP server process (`createPlaywrightCapture` opens one
shared browser context). The file contains live session cookies — never
commit it; the root `.gitignore` already excludes `.reactfig/` and
`*.storage-state.json` for this reason. If the target app's session
expires, regenerate the file the same way.

This is intentionally the simplest option that actually works for a
local dev server, not a general-purpose auth framework: it reuses
Playwright's own supported mechanism rather than reimplementing cookie
injection or a login flow.

## What's tested here, and what isn't

Every tool's **orchestration logic** — argument resolution, looping over
viewports/variants, evidence assembly, error propagation, chaining
`generate_design_ir` → `merge_design_ir_checkpoints` → `export_design_
artifact` — is tested directly (`test/`), using `MockModelProvider` (no
network) and an injected fake capture function (no browser), the same
pattern used throughout `@reactfig/analyzer`'s own test suite.

**Not tested here**: the real Playwright browser capture
(`src/playwrightCapture.ts`, the production default for
`generate_design_ir`'s `captureComponent`), Interactive Capture Mode's
browser-glue layer (`src/collection/collectionBrowser.ts` — launching the
page, injecting the overlay, wiring `exposeFunction`), and the MCP stdio
transport itself (`src/server.ts`'s `registerTool`/`connect` wiring).
These are real, type-checked code — `server.ts` type-checks against the
actual `@modelcontextprotocol/sdk` v1.30 API (verified by inspecting its
shipped type declarations directly, not assumed from memory) — but none
can be exercised in this repository's sandboxed dev environment: no
network access to download a Playwright browser binary, and no MCP
client to drive a real stdio session against. This is the same
disclosed-limitation category as `@reactfig/analyzer`'s own browser
layer and `@reactfig/model`'s provider adapters. Everything in
Interactive Capture that does NOT require an actual browser — the
manifest lifecycle, `CollectionSession`'s persistence (including a
simulated process-restart-and-resume), the fiber-walk boundary
resolution (`resolveComponentBoundary`, in `@reactfig/analyzer`), and the
full start → select → remove → navigate → finalize →
`generate_design_ir_from_capture` workflow — IS tested, using a fake
`attachBrowser` in place of a real Playwright page (the same seam
`GenerateDesignIrContext.captureComponent` already uses). Real-browser QA
of the overlay itself (hover highlighting, Shadow DOM isolation, SPA
navigation survival) is needed before relying on it in production — see
ADR 0026. The same applies to ADR 0027's additions to the overlay (the
output-format picker, the "Done / Continue" button, and
`__reactfigMarkDone`): the generated overlay script's syntax was checked
(`node --check` against the real built output of `buildOverlayScript()`),
and everything on the Node side of it — `writeContinuationSignal`,
`ContinuationBridge`, `get_interactive_capture_status`'s
`continuationPending` surfacing — IS tested directly, but the button and
picker actually rendering and working in a live page is not.

## Scope

No AI runs inside the plugin. The plugin itself lives in the separate
`@reactfig/figma-plugin` package (Phase 6, ADR 0011) — this package never
imports it and has no Figma-specific logic of its own; it only produces
the `.rfd` file the plugin later reads. No Figma MCP dependency anywhere
in this package.
No database, no cloud infrastructure, no bidirectional sync. This package
does exactly one thing: adapt the existing pipeline to the MCP tool-calling
protocol.