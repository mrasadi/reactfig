# ADR 0013: `generate_design_ir` still timing out after ADR 0012

## Status
Accepted — supersedes ADR 0012's implicit assumption (never stated as
confirmed, but left untested) that bounding every Playwright stage would
be *sufficient* to fix the reported `MCP error -32001: Request timed out`.
ADR 0012's diagnosis and fix (`networkidle` → bounded `load`, per-stage
timeouts, the `collectDomSnapshot` closure fix) are still correct and
still necessary — they are not reverted here. They were not sufficient.

## Context

A real-world report, reproduced against a real target application
(a separate local React app, `AuthPage.tsx`, `http://localhost:5173
/login`, selector `.auth-card`) via OpenCode + a local Qwen 3.6 model
through Ollama:

- `inspect_component_source` (AST-only, no browser, no model) — succeeds.
- `generate_design_ir` (browser capture + AI orchestration) — consistently
  fails with `MCP error -32001: Request timed out`, including with
  `maxToolIterations=20`.

The instruction that produced this ADR was explicit that ADR 0012's fix
"apparently did NOT solve the real-world timeout" and must be treated as
"a hypothesis that must now be verified, not as truth." It wasn't wrong,
exactly — it was incomplete: it fixed real bugs in the browser layer
without ever establishing that the browser layer was the *only* thing
standing between a tool call and a 60-second client timeout.

## Investigation

### Where does -32001 actually come from?

`-32001` is not a Playwright error, an Ollama error, or anything
`@reactfig/mcp` throws itself. It is the JSON-RPC error code the MCP
TypeScript SDK's own `Protocol` class (`@modelcontextprotocol/sdk`, both
client and server share this base class) uses for
`ErrorCode.RequestTimeout`, thrown by the **client** side of the
connection when a request's own timeout elapses before a response
arrives — confirmed directly in `node_modules/@modelcontextprotocol/sdk
/dist/esm/shared/protocol.js`:

```js
export const DEFAULT_REQUEST_TIMEOUT_MSEC = 60000;
// ...
const timeout = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
const timeoutHandler = () => cancel(McpError.fromError(ErrorCode.RequestTimeout, 'Request timed out', { timeout }));
```

**60 seconds, client-side, by default**, for *any* `tools/call` request
unless the calling code passes a longer `timeout` — a decision made by
the MCP client (OpenCode), not by `@reactfig/mcp`. This is why
`inspect_component_source` (fast — pure AST parsing, typically under a
second) never showed the symptom, while `generate_design_ir` (browser
capture, potentially several sequential model round-trips) did: nothing
about ADR 0012's fix changes the *aggregate* wall-clock duration of the
call, only how quickly each individual browser stage fails *if it's
going to fail*. A call that succeeds at every stage but simply takes
longer than 60 seconds in total looks identical, from the client's
perspective, to one that's actually stuck.

### Is this the actual bottleneck, or a coincidence?

Two independent pieces of evidence say it's real, not a coincidence:

1. **The math.** `interpretComponent` (`packages/analyzer/src/ai/
   interpret.ts`) runs up to `MAX_TOOL_ITERATIONS` (default 2)
   `generateWithTools` calls, then one `generateStructured` call, and
   `generateDesignIR`'s repair loop (`packages/analyzer/src/ai/
   orchestrate.ts`) can run that whole sequence up to `maxRepairAttempts +
   1` times (default 3 total attempts). Worst case: up to 3 × (5 + 1) = 18
   sequential HTTP calls to the model endpoint in one `generate_design_ir`
   invocation. A local Qwen-class model via Ollama commonly takes
   several seconds to tens of seconds per call for structured-output/
   tool-calling requests (hardware- and prompt-length-dependent) — even a
   modest 2–3 tool iterations plus one structured call, at 10–20s each,
   already exceeds 60 seconds before the browser capture stage (itself
   bounded at up to ~55s worst-case across launch/navigation/selector/
   capture per ADR 0012) is even counted.
2. **Confirmed, independent, real-world reports about OpenCode
   specifically.** Multiple open GitHub issues against OpenCode
   (`anomalyco/opencode` #8701, #8121, #23096) describe exactly this
   symptom for other MCP servers with long-running tools: `MCP error
   -32001: Request timed out` after roughly 30–60 seconds, *regardless*
   of the documented per-server `mcp.<name>.timeout` config value. One
   issue (#8701) explicitly states other MCP-capable harnesses —
   including Claude Code — work without issue using the *same* MCP
   server, which is strong evidence this is an OpenCode-specific
   client-side timeout-enforcement limitation, not something wrong with
   the server being called. OpenCode's own docs (`opencode.ai/docs/mcp-
   servers`) describe `timeout` as "Timeout in ms for fetching tools from
   the MCP server" — i.e. the `tools/list` handshake — not tool
   *execution*; there is currently no documented, working way to
   configure a longer tool-execution timeout in OpenCode.

### Conclusion

The real root cause is the combination of: (a) the MCP protocol's
60-second default client request timeout, (b) the pipeline's genuinely
uncertain and potentially long total duration (browser capture time +
up to 18 sequential local-model HTTP calls), and (c) — confirmed via
independent GitHub reports, not assumed — OpenCode specifically not
currently offering a working way to configure a longer tool-execution
timeout. ADR 0012's fixes were necessary (a hung browser stage would
make this strictly worse) but were never going to be sufficient on their
own, because they addressed correctness/boundedness of each stage, not
the aggregate duration against a client-side clock outside this
repository's control.

## Decision

Four changes, none of which is "increase a timeout":

### 1. MCP progress notifications (the spec-correct mechanism for this exact problem)

`generate_design_ir`'s tool handler now inspects the incoming request's
`_meta.progressToken` and, when present, sends `notifications/progress`
messages at every pipeline stage via `extra.sendNotification`
(`packages/mcp/src/progressReporter.ts`). This is the MCP specification's
own designed answer to "a tool call may legitimately take a long time":
a client that requests progress notifications and opts into
`resetTimeoutOnProgress` on its own `request()` call keeps its timeout
clock from expiring as long as progress keeps arriving. This is honestly
disclosed as **necessary but not sufficient**: whether a progress
notification actually prevents the client's timeout depends entirely on
whether the client (a) sends a `progressToken` at all and (b) opts into
resetting its timeout on progress — both are client-side decisions this
server cannot force or detect. It costs nothing when unsupported (no
token → no notifications sent, per spec, "the receiver is not obligated
to provide these") and directly helps any client that does support it
(Claude Code's MCP client is one confirmed-working example per the
OpenCode issue above) — including a future OpenCode release that fixes
its execution-timeout handling.

### 2. Full stage-level `REACTFIG_DEBUG` observability

The exact question the original bug report couldn't answer — "is it the
browser, or the model, or something else?" — now has a direct answer:
set `REACTFIG_DEBUG=true` and every stage listed in the brief (MCP
request received, project root resolved, source inspection start/finish,
browser launch start/finish, page creation, navigation, selector wait,
DOM snapshot, screenshot, evidence assembly, model call start/finish
*per call* with duration, IR construction, validation, artifact
generation, request completed/failed) writes one timestamped line to
`stderr` — never `stdout`, which the `stdio` MCP transport uses as its
wire protocol; a single accidental `stdout` write would corrupt the
JSON-RPC stream. See `packages/model/src/debugLog.ts` — the single
implementation, re-exported by `@reactfig/analyzer`'s `index.ts` rather
than duplicated, since `@reactfig/analyzer` already depends on
`@reactfig/model` and not the reverse (this was briefly duplicated
byte-for-byte across both packages; consolidated during the open-source
hardening pass). This turns "give me a manual test
and tell me exactly what to report back" (per the brief's own required
workflow) into something genuinely diagnostic: the C1 manual test in
`docs/e2e/phase7-report.md` now asks for the `REACTFIG_DEBUG=true`
timing log specifically, which will show directly whether a real
recurrence is a browser-stage problem, a model-call problem, or purely
the client-timeout problem this ADR addresses.

### 3. Cancellation — `AbortSignal` threaded end-to-end

`extra.signal` (an `AbortSignal` the MCP SDK ties to the request's
lifecycle — cancelled if the client disconnects or cancels) is now
forwarded from `server.ts` through `generateDesignIrTool` → each
`captureComponent` call → `generateDesignIR`/`interpretComponent` → every
`ModelProvider` call (`GenerateInput.signal`, combined with each
provider's own per-HTTP-call timeout via `AbortSignal.any` in both
`OpenAICompatibleProvider` and `AnthropicProvider`). Previously, a client
giving up on a request left the server with **no way to know** — browser
navigation and model HTTP calls kept running to completion, burning
Ollama/browser resources for a result nobody would read. This directly
addresses the brief's "no unbounded browser/model promises" and "whether
any promise is left unresolved" requirements — every promise in the
chain now has both a timeout-based and a cancellation-based exit.

### 4. Real bug found in the process: screenshots were never captured

While tracing "does a screenshot actually reach the model when
`REACTFIG_MODEL_VISION=true`" (an explicit item in the brief), the
production capture path (`packages/mcp/src/playwrightCapture.ts`) was
found to never pass `screenshotPath`/`contextScreenshotPath` to
`captureRenderedComponent` at all — regardless of the configured model's
vision capability. `RenderCapture.screenshot` was always `null` in real
usage; `interpretComponent`'s vision-aware logic (`packages/analyzer/src
/ai/interpret.ts`, `provider.capabilities.vision && bundle
.primaryScreenshotPath`) was already correct but had nothing to act on.
**`REACTFIG_MODEL_VISION=true` had no observable effect on evidence
quality before this fix.** Now fixed: `generateDesignIrTool` passes
`captureScreenshot: ctx.provider.capabilities.vision` on every
`CaptureRequest`, and `playwrightCapture.ts` only computes screenshot
paths (under `<projectRoot>/.reactfig/screenshots/`, already `.gitignore`d)
when that flag is true — deliberately conditional, not "always capture
and decide later," because a screenshot is one more sequential browser
round-trip inside a request that already has the wall-clock problem this
whole ADR is about.

## What this does NOT claim

- This does not claim the real-world OpenCode timeout is now guaranteed
  fixed. Whether progress notifications actually prevent it depends on
  OpenCode's client-side behavior, which this repository cannot control
  or fully verify without a real OpenCode session (see the manual test
  below).
- This does not claim vision now works end-to-end with Qwen 3.6 — only
  that a screenshot is now actually captured and reaches the model layer
  when vision is enabled; whether the configured Qwen 3.6 build genuinely
  supports vision, and produces materially different output when given
  one, is unverified (Category C, `docs/e2e/phase7-report.md`).
- This does not add a configurable timeout knob for the pipeline's
  internal stages (deliberately — see ADR 0012's existing reasoning:
  making timeouts tunable reopens the door to "fix" future bugs by
  raising a number instead of finding the real cause).

## The one manual test that would confirm or refute this for real

Re-run the exact originally-reported call:

```
reactfig-mcp_generate_design_ir
  sourceFile=src/pages/Auth/AuthPage.tsx
  componentName=AuthPage
  url=http://localhost:5173/login
  selector=.auth-card
```

with `REACTFIG_DEBUG=true` set in the MCP server's environment. **Report
back the full `stderr` timing log**, not just success/failure — if it
still times out, the log shows exactly which stage was in progress when
the client gave up (browser stage vs. a specific model-call number),
which is the one piece of information neither this ADR nor ADR 0012
could produce without a real OpenCode + real target app + real local
model in the loop. See `docs/e2e/phase7-report.md`, test **C1**, for the
full procedure.

## Addendum: three follow-up fixes from the first real re-test

A real re-test of the fix above (against `SessionCard.tsx`, not
`AuthPage.tsx`) came back with the same `MCP error -32001` — with no
`stderr` log attached at all — and used `maxToolIterations=15,
maxRepairAttempts=2` plus a free-text `prompt` argument the original
schema didn't define. All three of these are real findings, not restated
speculation:

**1. No `stderr` log means the client isn't surfacing it, not that
debug logging failed.** Per this ADR's own GitHub-issue research above,
OpenCode is already confirmed to have nonstandard behavior around
long-running MCP tool calls; it's entirely plausible (though not yet
confirmed — see the updated manual test below) that it also doesn't
surface a `stdio` server's `stderr` anywhere in its chat UI. Rather than
depend on that, `debugLog` (in both `@reactfig/analyzer` and
`@reactfig/model`) now *also* mirrors every line to a plain file on
disk — `REACTFIG_DEBUG_LOG_FILE` if set, otherwise
`<os.tmpdir()>/reactfig-debug.log` by default whenever `REACTFIG_DEBUG=
true` — so there's always one predictable, `tail -f`-able location
regardless of what the MCP client does with `stderr`. The first line
written in the process names the exact path, once.

**2. `maxToolIterations=15` with `maxRepairAttempts=2` is worst-case ~48
sequential model calls in one tool call — self-defeating, not
thorough.** Nothing previously bounded these from above; an agent
(reasonably, in isolation) assuming "more iterations = more thorough
capture" could set a value that makes the exact problem this ADR fixes
dramatically worse. `maxToolIterations` is now capped at 8 (default 5)
and `maxRepairAttempts` at 3 (default 2) at the MCP tool-schema level
(`packages/mcp/src/toolSchemas.ts`), with the schema description
explaining directly *why* a higher value doesn't help: the model already
sees the full DOM tree, computed styles, and (when vision is enabled) a
screenshot on its first turn — more iterations mean more chances to
re-request evidence it already has, not more thoroughness. A value
outside these bounds is now an immediate, clear Zod validation error
instead of a multi-minute hang.

**3. The `prompt` argument was accepted but silently did nothing.**
`generate_design_ir`'s schema had no `prompt` field; Zod's default
unknown-key handling strips extra properties rather than rejecting them,
so the call proceeded normally with the free-text guidance simply
discarded — no error, no effect, and no way to tell from the response
that it had been ignored. This is now a real, documented parameter:
`prompt` is appended to the model's system prompt (the same mechanism
`orchestrate.ts`'s repair-context uses) via a new `guidance` option
threaded through `generateDesignIrTool` → `generateDesignIR` →
`interpretComponent`. Its schema description is explicit that it only
changes *interpretation*, not *what evidence is captured* — for
capturing multiple visual states (e.g. completed/scheduled/missed card
statuses, the actual case that prompted this), the existing `variants`
array (distinct selectors or `propValues` per capture) is still the
correct mechanism, since that's deterministic evidence, not something a
prompt can substitute for.

### Updated manual test

Same as **C0** above, but now:
- Set `REACTFIG_DEBUG=true` (log file mirroring is automatic — no extra
  variable needed unless you want a specific path via
  `REACTFIG_DEBUG_LOG_FILE`).
- Use default or near-default `maxToolIterations`/`maxRepairAttempts` for
  this re-test specifically (e.g. omit both, or use `maxToolIterations=5`)
  — isolate whether the *base* fix works before layering a large budget
  back on top of it.
- If the MCP client's own chat UI shows nothing useful on `stderr`, check
  `<your tmp dir>/reactfig-debug.log` directly (macOS: usually under
  `/var/folders/...` or `$TMPDIR` — run `node -e "console.log(require('os').tmpdir())"`
  if unsure, or just set `REACTFIG_DEBUG_LOG_FILE=/tmp/reactfig-debug.log`
  explicitly to make the path predictable).
- Report back the same three things as the original C0 test, from
  whichever of `stderr`/the log file actually has content.
