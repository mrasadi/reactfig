# Environment variable audit

A complete audit of every `process.env.*` / CLI argument this repository
reads, as of Phase 8. This is the entire configuration surface — there
is no other file, hidden default, or hardcoded path outside what's
listed here. All of it lives in `@reactfig/mcp` (`src/server.ts`,
`src/projectRoot.ts`, `src/providerConfig.ts`); no other package reads
`process.env` or `process.argv` at all — `@reactfig/core`,
`@reactfig/model`, `@reactfig/analyzer`, `@reactfig/artifact`, and
`@reactfig/figma-plugin` all take their configuration as explicit
function/constructor arguments, never ambient environment.

## Configuration groups

Per the brief's requirement to separate these concerns, they genuinely
don't overlap in this codebase — there is no variable that means two
different things depending on context:

### 1. Target-project configuration (which React app to inspect)

| Variable / flag | Required | Default | Notes |
|---|---|---|---|
| `--project <path>` | No | — | CLI flag, highest-priority operator override |
| `REACTFIG_PROJECT_ROOT` | No | — | Same override as `--project`, as an env var. **These two are the exact same setting, not two different ones** — see ADR 0012, Failure 3, for the real-world config mistake this ambiguity caused. |

If neither is set, the server falls back to the MCP client's advertised
`roots/list` workspace root (if the client supports it), then finally
`process.cwd()`. Full precedence order and rationale: `packages/mcp/src
/projectRoot.ts`'s module doc comment and ADR 0012.

This is **not** "ReactFig's own installation directory" — the server
never needs to know where its own code lives; `node
path/to/dist/server.js` is sufficient for Node to load it. This variable
is exclusively "which React project should this tool call target."

### 2. Model/provider configuration

Set once at server startup (`createProviderFromEnv`,
`packages/mcp/src/providerConfig.ts`), not per tool call.

| Variable | Required | Default | Applies to |
|---|---|---|---|
| `REACTFIG_MODEL_PROVIDER` | No | `"openai-compatible"` | both |
| `REACTFIG_MODEL_BASE_URL` | **Yes**, if provider is `openai-compatible` | none | openai-compatible |
| `REACTFIG_MODEL_NAME` | **Yes**, if provider is `openai-compatible`; optional for `anthropic` | none / `"claude-sonnet-5"` | both |
| `REACTFIG_MODEL_API_KEY` | No | `"sk-local-1234"` (a placeholder, not a real credential — most local Ollama servers don't check it) | openai-compatible |
| `REACTFIG_MODEL_VISION` | No | `false` | openai-compatible (conservative default: assume no vision support until told otherwise) |
| `REACTFIG_MODEL_TOOLS` | No | `true` | openai-compatible |
| `ANTHROPIC_API_KEY` | **Yes**, if provider is `anthropic` | none | anthropic |

`REACTFIG_MODEL_BASE_URL`/`REACTFIG_MODEL_NAME` have **no fallback
values** for `openai-compatible` — this is deliberate, see ADR 0012's
"Bonus finding": an earlier version silently defaulted a missing model
name to the literal string `"vision"`, which meant a misconfigured
environment would start successfully and then fail confusingly mid
tool-call instead of failing clearly at startup. Missing either one now
throws immediately when the server starts.

### 3. Browser/capture configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `REACTFIG_STORAGE_STATE` | No | none (unauthenticated context) | Path to a Playwright `storageState` JSON file, for capturing components behind login. See `packages/mcp/README.md`, "Authenticated development apps." Never commit this file — it contains live session cookies; `.gitignore` excludes `.reactfig/` and `*.storage-state.json` for exactly this reason. |

Screenshots (when captured — see below) are written under
`<projectRoot>/.reactfig/screenshots/`, not environment-configurable;
already `.gitignore`d for the same reason as `REACTFIG_STORAGE_STATE`.

Timeouts (`LAUNCH_TIMEOUT_MS`, `NAVIGATION_TIMEOUT_MS`,
`SELECTOR_TIMEOUT_MS` in `packages/mcp/src/playwrightCapture.ts`) are
intentionally **not** environment-configurable — they're fixed,
generous, and every failure mode already produces a specific,
actionable error naming which stage timed out (see ADR 0012). Making
them tunable would let the exact original bug ("just increase the
timeout") come back through a different door instead of fixing the
actual `networkidle` root cause. The same applies to the AI-orchestration
loop's own bounds (`maxRepairAttempts`, `maxToolIterations`) — those are
already per-call tool arguments (not env vars), on purpose: unlike the
browser timeouts, a caller has a legitimate reason to want a shorter
loop for a slow local model (see ADR 0013), so they're exposed, but at
the tool-call layer where a client can reason about the trade-off, not
as a global environment default.

### 5. Diagnostics

| Variable | Required | Default | Notes |
|---|---|---|---|
| `REACTFIG_DEBUG` | No | unset (no logging) | `true` or `1` enables per-pipeline-stage timing logs to `stderr` — see ADR 0013 for why this exists (diagnosing exactly where a slow `generate_design_ir` call spends its time: browser stage vs. which numbered model call). Never writes to `stdout`, which the MCP `stdio` transport uses as its wire protocol. |
| `REACTFIG_DEBUG_LOG_FILE` | No | `<os.tmpdir()>/reactfig-debug.log` when `REACTFIG_DEBUG` is on | Every debug line is also mirrored to this file, in addition to `stderr` — added after a real report where `REACTFIG_DEBUG=true` was set but no `stderr` output was visible anywhere in the MCP client's UI (confirmed as a real gap for at least some clients — see ADR 0013's addendum). Has no effect unless `REACTFIG_DEBUG` is also on. |

### 6. Artifact/output configuration

No dedicated environment variable — `export_design_artifact`'s
`outputPath` is a per-call tool argument (defaults to
`design/<document name>.rfd` under the resolved project root when
omitted), not global server configuration, because different components
in the same session legitimately want different output paths. See
`packages/mcp/src/server.ts`'s `export_design_artifact` tool schema.

## Precedence order, summarized

Only group 1 (project root) has more than one source, so it's the only
place precedence matters:

```
per-call `projectRoot` argument
  > --project / REACTFIG_PROJECT_ROOT (same setting, two spellings)
    > MCP client's roots/list (if advertised)
      > process.cwd()  (documented last resort)
```

Every other variable (model config, storage state) has exactly one
source — no precedence to document because there's nothing to resolve
between.

## Example configurations

### Ollama + Qwen (local, no vision, tool calling)

```bash
REACTFIG_MODEL_PROVIDER=openai-compatible   # default, can be omitted
REACTFIG_MODEL_BASE_URL=http://localhost:11434/v1
REACTFIG_MODEL_NAME=qwen3.6
REACTFIG_MODEL_VISION=false                 # default; omit unless the pulled model actually supports vision
REACTFIG_MODEL_TOOLS=true                   # default
REACTFIG_DEBUG=true                         # recommended while diagnosing a slow/failing generate_design_ir call — see ADR 0013
```

### Generic OpenAI-compatible endpoint (e.g. LiteLLM, self-hosted)

```bash
REACTFIG_MODEL_PROVIDER=openai-compatible
REACTFIG_MODEL_BASE_URL=http://localhost:4000/v1
REACTFIG_MODEL_NAME=gpt-4o-mini
REACTFIG_MODEL_API_KEY=sk-...                # if your endpoint checks it
```

### Anthropic

```bash
REACTFIG_MODEL_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
REACTFIG_MODEL_NAME=claude-sonnet-5
```

### Full MCP client registration, target project separate from ReactFig's own install

```json
{
  "mcpServers": {
    "reactfig": {
      "command": "node",
      "args": ["/path/to/reactfig/packages/mcp/dist/server.js", "--project", "/path/to/your-react-app"],
      "env": {
        "REACTFIG_MODEL_PROVIDER": "openai-compatible",
        "REACTFIG_MODEL_BASE_URL": "http://localhost:11434/v1",
        "REACTFIG_MODEL_NAME": "qwen3.6"
      }
    }
  }
}
```

Note there is exactly one project-root setting here (`--project`), not
two — no `REACTFIG_PROJECT_ROOT` alongside it, and it points at the
target React app, never at ReactFig's own checkout. This is the
corrected version of the configuration mistake documented in ADR 0012,
Failure 3.

## No secrets committed

Nothing above has a real-looking default that could be mistaken for a
committed secret — `REACTFIG_MODEL_API_KEY`'s default
(`sk-local-1234`) is an obviously-fake local placeholder, and both real
credential variables (`ANTHROPIC_API_KEY`, and `REACTFIG_MODEL_API_KEY`
when set to something real) have no default at all. The root
`.gitignore` excludes `.env`/`.env.*` and Playwright storage-state files
so a real key or session file can't be committed by accident.
