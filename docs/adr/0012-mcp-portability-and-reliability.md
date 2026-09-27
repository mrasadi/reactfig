# ADR 0012: MCP portability and reliability fixes (Phase 8)

## Status
Accepted

## Context
Phase 6.5 shipped `@reactfig/mcp` with tests against a mock capture
function and a mock model provider — deliberately, since no real browser
binary or MCP client is reachable from this repository's sandboxed dev
environment (see `packages/mcp/README.md`, "What's tested here, and what
isn't"). Running the server for real, from an actual MCP client
(OpenCode) against an actual local React dev server and an actual local
Qwen model through Ollama, surfaced four distinct real-world failures
that no test in this repository had reproduced, because reproducing them
requires exactly the real browser/client/model access the sandbox
doesn't have. This ADR records what each failure actually was, the root
cause, and the fix — not a guess, and not "increase the timeout."

## Failure 1: `COMPUTED_STYLE_PROPERTIES is not defined`

**Symptom.** `generate_design_ir` failed during DOM snapshot collection
with a `ReferenceError` for a name that is very obviously defined, at
module scope, in the same file as the function that referenced it.

**Root cause.** `collectDomSnapshot` is passed to Playwright's
`page.evaluate(fn, arg)`, which serializes `fn` via `Function.prototype
.toString()` and evaluates *only that source text* inside the page's own
JS context — a separate process, with no access to the calling Node
module's scope. Any identifier `collectDomSnapshot` referenced that
wasn't declared inside its own function body (the module-level
`COMPUTED_STYLE_PROPERTIES` constant, and several sibling helper
functions) was invisible at the point Playwright's serialized string ran
in the browser.

**Fix.** `packages/analyzer/src/browser/collectDomSnapshot.ts` now
inlines every value and helper function `collectDomSnapshot` needs
inside its own body — `STYLE_PROPERTIES`, `directTextContent`,
`findFiberKey`, `componentDisplayName`, `getComponentPath`, `walk`. The
module-level `COMPUTED_STYLE_PROPERTIES` export still exists (other,
Node-side code — `evidence/interpretDomSnapshot.ts` — legitimately
imports it), but `collectDomSnapshot` itself no longer depends on it.

**Regression test.**
`packages/analyzer/test/browser/collectdomsnapshotselfcontained.test.ts`
reproduces the actual serialization boundary rather than just calling
the function directly (which would pass even with the bug, since a
direct call still has closure access): it extracts
`collectDomSnapshot.toString()` and reconstructs it via `new Function`
in a scope that has access to nothing but the same three globals a real
browser page provides (`document`, `getComputedStyle`, `Node`). It also
asserts the inlined `STYLE_PROPERTIES` list matches the exported
`COMPUTED_STYLE_PROPERTIES` exactly, so the two can't silently drift.

## Failure 2: `generate_design_ir` timing out (`MCP error -32001`)

**Symptom.** Real invocations against a real local dev server
consistently returned `MCP error -32001: Request timed out`, including
with `maxToolIterations=20`.

**Root cause.** `page.goto(url, { waitUntil: "networkidle" })` with no
explicit navigation timeout. `networkidle` waits for zero in-flight
network requests for 500ms straight; it never fires for an app doing
any polling, an open WebSocket, or an analytics beacon — which describes
most real React dev apps. The call would hang until the *MCP client's*
own request-level timeout fired, with no information from ReactFig about
which stage was actually stuck (navigation? selector wait? DOM
snapshot?).

**Fix.** `packages/mcp/src/playwrightCapture.ts`:
- `page.goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS })`
  — `load` is the browser's own one-shot load event, not a heuristic
  about ongoing traffic.
- Every stage now has its own bounded timeout and a distinct,
  actionable error: browser launch (30s, with an install hint when the
  failure looks like a missing Chromium binary), navigation (15s),
  selector wait (10s), and DOM/screenshot capture (wrapped so failures
  there are attributed to that stage, not misreported as a navigation
  or selector problem).
- No unbounded wait exists anywhere in the capture path.

This still cannot be exercised end-to-end inside this repository's own
test suite — there is no network path here to a Playwright browser
binary — so it remains a real, disclosed gap covered by the manual test
in `docs/e2e/phase7-report.md`, not something this ADR claims is
verified.

## Failure 3: MCP server inspecting the wrong repository

**Symptom.** The server inspected ReactFig's own repository instead of
the target React application it was supposed to analyze.

**Root cause.** The original implementation used `process.cwd()` as soon
as no `--project`/env override was given. `process.cwd()` for a
Node-launched `stdio` MCP server is whatever directory the *client*
happened to spawn the process from — not necessarily, and in practice
often not, the target project. There was also no path to ask the MCP
client itself, so every project the operator wanted to point at required
a hardcoded `--project` flag.

**Fix.** `packages/mcp/src/projectRoot.ts` establishes an explicit
priority order, highest first:

1. A `projectRoot` argument on the specific tool call.
2. `--project <path>` / `REACTFIG_PROJECT_ROOT` — set once at server
   startup.
3. The MCP client's advertised workspace root, via the `roots/list`
   protocol feature — queried once, after the `initialize` handshake
   completes (`server.ts` does this after `connect()`, since client
   capabilities aren't known before then), and only if the client
   actually advertised `roots` support. This never blocks startup and
   is never fatal if the client doesn't support it or the request
   fails — most clients don't yet.
4. `process.cwd()` — a documented last resort, not the first guess.

**On the operator's own config mistake.** The specific configuration
that motivated this ADR set `REACTFIG_PROJECT_ROOT` to ReactFig's own
checkout while `--project` pointed at the target app. Given the priority
order above, `--project` wins in that case (priority 2's two forms are
the *same* override, not two independent settings — there is only one
"operator-level target project root" concept, not a separate "ReactFig
installation root" and "target root"). ReactFig's own installation
location is never something the server needs to know; `node
<path-to-server.js>` is enough for Node to load its own code. The
practical bug was documentation, not architecture: nothing previously
stated plainly that `REACTFIG_PROJECT_ROOT` and `--project` are the
exact same override, so it read as plausible that they were two
different variables. `packages/mcp/README.md`'s registration example and
`providerConfig`/`projectRoot` doc comments now say this explicitly.

## Failure 4: MCP client couldn't reliably use the connection

**Symptom.** OpenCode reported `MCP error -32000: connection closed`;
running `node packages/mcp/dist/server.js --project ...` manually
appeared to hang with no output, which is ambiguous for a `stdio`
transport (silence is the *correct* steady state once connected — there
is nothing to print).

**Investigation.** `server.ts` was audited end-to-end against
`@modelcontextprotocol/sdk`'s actual shipped type declarations (not
assumed from memory):
- `registerTool`'s handler signature, and `McpServer`/`StdioServerTransport`
  construction, match the installed SDK version.
- Nothing before `await server.connect(new StdioServerTransport())` does
  browser or model-provider I/O that could throw or hang pre-handshake —
  `createProviderFromEnv()` only constructs a provider object (no
  network call), and `createPlaywrightCapture()` only returns a closure
  (the browser itself launches lazily, on first real capture request,
  not at startup). A server that blocks or crashes before `connect()`
  is indistinguishable, from the client's side, from "connection
  closed."
- Nothing in the module writes to `stdout` — `stdio` transports use
  `stdout` as the wire protocol itself; a single stray `console.log`
  would corrupt every message. Diagnostic output (`main().catch` on
  startup failure) goes to `stderr`, which `StdioServerTransport` never
  touches.
- `package.json`'s `"type": "module"` / ESM build output was confirmed
  to match what `tsc` actually emits into `dist/`, and the `#!/usr/bin/env
  node` shebang plus executable bit make direct invocation viable.

**Conclusion.** The server-side code was already structurally correct
for `stdio` MCP; nothing found in this repository accounts for a
client-observed "connection closed" on its own. The two most likely
external explanations are (a) `providerConfig`'s `createProviderFromEnv`
throwing synchronously during `main()` on a genuinely missing/invalid
env var — now a clear, immediate `stderr` error rather than a silent
one, and now also impossible to accidentally suppress by way of the
`REACTFIG_MODEL_NAME` default bug described below — or (b) a client-side
process-management issue outside this repository's control. This is the
one item in this ADR that is a documented investigation rather than a
confirmed-and-fixed bug: see the manual test in
`docs/e2e/phase7-report.md` for the exact command to re-run and the
exact `stderr` output to capture if it recurs.

## Bonus finding: a silently-wrong default masked its own guard rail

While auditing `providerConfig.ts` for failure 4, `createProviderFromEnv`
was found to default a missing `REACTFIG_MODEL_NAME` to the literal
string `"vision"` and a missing `REACTFIG_MODEL_BASE_URL` to
`http://localhost:4000/v1` — both silently, inside the same function
whose explicit purpose (per its own required-field check right below the
defaults) was to *reject* a missing model/base URL with a clear startup
error. Because both defaults were truthy strings, that check could never
fire: an operator who forgot to set `REACTFIG_MODEL_NAME` would get a
server that started successfully and then failed confusingly, mid
`generate_design_ir` call, trying to reach a model literally named
`"vision"` on a default port nothing was listening on — exactly the
"confusing failure mid-request instead of a clear error at startup"
category of bug this whole ADR is about. The repository's own test
(`packages/mcp/test/providerConfig.test.ts`) already asserted the
correct behavior (`createProviderFromEnv({})` should throw) — the
defaults simply made that assertion false, and the test was failing
before this fix. Both defaults are removed; `REACTFIG_MODEL_BASE_URL`
and `REACTFIG_MODEL_NAME` are now unconditionally required for the
`openai-compatible` provider, matching what `packages/mcp/README.md`
already documented.

## Consequences

- Every browser-facing operation in the MCP capture path now fails
  fast, with a stage-specific, actionable message, instead of hanging
  until an external timeout fires.
- Project-root resolution has one well-defined precedence order with no
  redundant/ambiguous configuration surface.
- A missing or wrong model configuration is caught at server startup,
  not mid-request.
- Failure 2 (real browser reliability) and failure 4's external half
  (real MCP client interoperability) remain genuinely unverified by this
  repository's own test suite, because verifying them requires a real
  browser binary and a real MCP client this sandbox does not have
  network/runtime access to. That is a disclosed limitation, not a
  claimed pass — see `docs/e2e/phase7-report.md` for the exact manual
  test to run and what to report back.
