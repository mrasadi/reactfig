# Contributing

## Development setup

```bash
pnpm install
pnpm build
pnpm test
```

Requires Node >= 20 and pnpm >= 9.

Capture and Design IR generation work with no configuration. The
AI-assisted tools (`@reactfig/mcp`'s `generate_design_ir`) need a model
provider — copy `.env.example` to `.env` and see `docs/environment.md`
for every variable, or `docs/local-model-setup.md` for a fully local
setup (Ollama + LiteLLM).

## Repository shape

This is a pnpm-workspace monorepo. See `docs/README.md` for the full
documentation index, `docs/architecture.md` for what each package is
responsible for, and `docs/adr/` for why the boundaries are drawn
where they are before proposing a restructure.

## Where things belong

- Changes to the Design IR shape (new node kinds, new properties) go in
  `packages/core`, must update the JSON Schema, and need an ADR if they
  expand v1 scope (see ADR 0002).
- Anything that talks to a model provider goes through the `ModelProvider`
  interface in `packages/model` — no provider-specific code in
  `packages/analyzer` or `packages/mcp`.
- The renderer (`packages/figma-plugin/src/code`) must stay deterministic —
  it should never need to know about `packages/model`. If a change requires
  the renderer to "ask the AI," that logic belongs in the IR generation step
  instead (see ADR 0003's rationale for why this separation matters).

## Adding a new MCP tool

Keep the tool surface intentional (see `docs/architecture.md`'s MCP
section). Prefer extending an existing tool's input over adding a new tool
that does almost the same thing.

## Tests

At minimum, PRs touching:
- `packages/core` need schema/validation tests,
- the renderer need deterministic transform tests,
- `packages/artifact` need serialize/deserialize round-trip tests.

## Reporting issues

Please include: the React component/pattern that didn't convert correctly,
the generated Design IR (if you got that far), and which stage (inspection,
analysis, artifact, plugin import) is where things went wrong.
