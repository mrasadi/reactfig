# ReactFig

Turn real React UIs into editable, structured design artifacts.

ReactFig captures a real interface in a real browser — DOM structure,
computed styles, layout geometry, screenshots, and (when available)
React source evidence — and reconstructs it as a structured **Design
IR**, exportable to Figma, HTML, SVG, or JSON. It doesn't treat a UI as
a screenshot to trace; it captures evidence first and exports later, so
the same capture can feed multiple output formats.

```
Real Browser  →  Capture (DOM / React / styles / screenshots)  →  Design IR  →  Figma / HTML / SVG / JSON
```

See [docs/architecture.md](docs/architecture.md) for the full design,
and [docs/README.md](docs/README.md) for everything else in `docs/`.

## Packages

| Package | What it does |
|---|---|
| [`@reactfig/core`](packages/core) | The Design IR contract (`design-ir/v1`): TypeScript types + JSON Schema + validator. |
| [`@reactfig/analyzer`](packages/analyzer) | Turns a running React app into an Evidence Model, and orchestrates AI interpretation into a Design IR document. |
| [`@reactfig/model`](packages/model) | Provider-agnostic model interface — OpenAI-compatible endpoints (local or hosted) and Anthropic. |
| [`@reactfig/artifact`](packages/artifact) | Packs/unpacks the portable `.rfd` artifact format. |
| [`@reactfig/mcp`](packages/mcp) | MCP server exposing the pipeline as tools for agents/editors. |
| [`@reactfig/figma-plugin`](packages/figma-plugin) | Imports a `.rfd` artifact and renders it as native, editable Figma content. |

## Quick start

Requires Node ≥ 20 and pnpm ≥ 9.

```bash
git clone https://github.com/reactfig/reactfig.git
cd reactfig
pnpm install
pnpm build
pnpm test
```

Try it against the bundled sample app (`examples/sample-react-app`), or
open `examples/sample-artifacts/SessionCard.demo.rfd` in the Figma
plugin to see an import without running a capture at all.

## Using the AI-assisted tools

Capture and Design IR generation are deterministic and need no AI. The
optional `generate_design_ir` MCP tool adds semantic interpretation on
top, and needs a model provider configured via environment variables:

```bash
cp .env.example .env
# then edit .env — see docs/environment.md for every variable
```

Works with Anthropic directly, or any OpenAI-compatible endpoint —
including a fully local setup (Ollama + LiteLLM, no hosted API). See
[docs/local-model-setup.md](docs/local-model-setup.md) for a complete
walkthrough of running it that way.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev workflow, where
changes belong, and testing expectations. Check
[docs/adr/](docs/adr/) before proposing a restructure — many boundaries
here exist for a specific, documented reason.

## Known limitations

- Full portal content capture isn't supported yet; portal usage is detected.
- Interaction-state capture hasn't been fully verified against a real browser.
- Border color isn't captured independently per side.
- `repeating-linear-gradient()` and similar aren't supported.
- Figma `instanceSwap` component properties aren't supported.
- Angular, Vue, and Svelte component-aware analysis aren't supported (DOM-based fallback still works).

## License

MIT — see [LICENSE](LICENSE).
