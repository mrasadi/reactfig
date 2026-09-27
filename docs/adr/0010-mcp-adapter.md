# ADR 0010: `@reactfig/mcp` as a thin adapter (Phase 6.5)

## Status
Accepted

## Context
`@reactfig/mcp` existed only as a package.json/README stub since Phase 1,
describing a 7-tool surface (`inspect_react_project`,
`inspect_component`, `inspect_component_tree`, `capture_component`,
`analyze_component`, `generate_design_ir`, `validate_design_ir`,
`export_design_artifact` across different drafts of the README/architecture
doc). By Phase 5, the pipeline those tools would wrap already existed as
tested, exported functions across `@reactfig/analyzer` (AST inspection,
browser capture, evidence assembly, AI orchestration),
`@reactfig/model` (provider configuration), and `@reactfig/artifact`
(packaging). The task was to review those public APIs and design the
smallest MCP surface over them — explicitly not to re-implement or
duplicate any of that logic inside the MCP package.

## Decision: four tools, not seven

- `generate_design_ir` — capture (browser) → inspect (AST) → evidence →
  AI orchestration → validated Design IR, in one call.
- `export_design_artifact` — Design IR → `.rfd`, written to disk.
- `inspect_component_source` — AST-only, standalone.
- `validate_design_ir` — schema check, kept explicitly as a
  debugging/inspection tool per the instruction, not a required pipeline
  step (the pipeline already validates internally at two points:
  `generateDesignIR`'s own bounded repair loop, and `pack()` itself).

The original sketch's `inspect_react_project`, `inspect_component_tree`,
`capture_component`, and `analyze_component` were folded into
`generate_design_ir`: a client asking an agent to "export the SessionCard
component" should not need to call four tools in sequence to get there —
that's exactly the "client should not need to manually orchestrate
low-level steps" requirement. Each of those four steps still exists as a
distinct, independently-tested function in `@reactfig/analyzer`
(`inspectComponentSource`, `captureRenderedComponent`,
`buildComponentEvidence`, `generateDesignIR`) — `generate_design_ir`'s
handler is a straight-line composition of them, not a reimplementation.

## Decision: model provider configured at server startup, not per tool call

`createProviderFromEnv()` reads `REACTFIG_MODEL_PROVIDER`/
`REACTFIG_MODEL_BASE_URL`/`REACTFIG_MODEL_NAME`/etc. once, when the server
starts, and the resulting `ModelProvider` is closed over by every tool
handler. Tool argument schemas stay focused on "which component to
analyze, from where" — not "which model to use this time," matching how
credentials are handled by essentially every other MCP server (env vars,
not request payloads) and avoiding a footgun where a malicious or
careless client could redirect a tool call at an arbitrary endpoint.

## Decision: browser capture is dependency-injected

`GenerateDesignIrContext.captureComponent` is a function type, not a
concrete Playwright call. Production wiring (`server.ts`) supplies the
real implementation (`src/playwrightCapture.ts`, lazily launching one
shared Chromium instance and delegating to `@reactfig/analyzer`'s
`captureRenderedComponent` — no inspection logic of its own). Tests supply
a fake implementation returning pre-built `RenderCapture` fixtures. This
is the same pattern used throughout the repository wherever something
requires infrastructure unavailable in this sandboxed dev environment (no
network to download a browser binary, no live model endpoint) — see
`@reactfig/analyzer`'s own `collectDomSnapshot`/`captureComponent.ts` and
`@reactfig/model`'s provider adapters for precedent. It means
`generateDesignIrTool`'s actual orchestration logic — argument resolution,
looping over viewports and variants, evidence assembly, error handling —
is fully covered by tests independent of whether a real browser is
available, while the one genuinely untestable seam (driving an actual
Chromium instance) stays isolated to a single small file.

## Decision: `export_design_artifact` fetches assets, `pack()` still doesn't

Per ADR 0009, `@reactfig/artifact`'s `pack()` deliberately does not fetch
asset bytes itself — that was flagged at the time as "an
analyzer/MCP-level orchestration concern kept out of the packaging layer."
This phase resolves that: `exportDesignArtifactTool` best-effort fetches
any `http(s)`-looking `AssetRef.path` (via an injectable `fetchImpl`,
same DI pattern as above) before calling `pack()`, and passes through
whatever it managed to resolve. A fetch failure is recorded as a
non-fatal warning, not a thrown error — consistent with `pack()`'s own
policy of recording an unembedded asset honestly rather than blocking the
whole export over one unreachable image.

## Consequences

- Every tool handler is a plain, exported async function
  (`(args, ctx) => Promise<Result>`), independent of the MCP SDK's
  request/response machinery — `server.ts` is the only file that touches
  `McpServer`/`registerTool`/`StdioServerTransport`, and it's a thin
  wiring layer (zod schemas + `toResult()` JSON-stringify), not where any
  logic lives. This is also why testing tool handlers directly (rather
  than spinning up a real MCP client/server pair over stdio) is sufficient
  and consistent with how the rest of the repository is tested.
- `server.ts`'s `registerTool` calls were verified against the actual
  shipped `@modelcontextprotocol/sdk` v1.30 type declarations (inspected
  directly from `node_modules`, not assumed from training data or search
  snippets) — the constructor, `registerTool(name, {description,
  inputSchema}, handler)` shape, and `StdioServerTransport` import path
  are all confirmed correct against the real package.
- 18 new tests (bringing the project total to 154 across
  core/model/analyzer/artifact/mcp), all passing against a completely
  clean `pnpm install`; the whole workspace typechecks clean.

## Known limitations

- Real Playwright browser capture and the real MCP stdio transport are
  untested in this sandboxed environment — see `packages/mcp/README.md`,
  "What's tested here, and what isn't," for the precise boundary.
- `generate_design_ir`'s `variants` parameter lets a client point
  different prop combinations at different URLs/selectors (e.g. different
  Storybook stories), but there's no tool-level help for *discovering*
  what those URLs/selectors should be — that discovery is left to the
  calling agent (e.g. reading a Storybook config or route table itself).
  Out of scope for a thin adapter; could be revisited if it becomes a
  recurring friction point.
