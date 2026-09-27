# @reactfig/model

The provider-agnostic `ModelProvider` interface (`generate`,
`generateStructured`, `generateWithTools`, `analyzeImage`), plus:

- `MockModelProvider` — fully deterministic, no-network, script-driven.
  Used by every test in `@reactfig/analyzer`'s AI orchestration
  (`packages/analyzer/test/ai/`) — the normal test suite never talks to a
  real model.
- `OpenAICompatibleProvider` — targets any `/chat/completions`-shaped
  endpoint. Covers Ollama (and therefore local Qwen 3.6), OpenAI, and most
  self-hosted inference servers with zero model-specific code.
- `AnthropicProvider` — targets the Anthropic Messages API.

See `docs/adr/0004-model-provider-abstraction.md` for why the interface has
exactly four methods and exactly two reference adapters, and
`docs/analyzer/ai-orchestration.md` for how `@reactfig/analyzer` uses this
package.

## Capabilities are explicit, not auto-detected

```ts
new OpenAICompatibleProvider({
  baseUrl: "http://localhost:11434/v1",
  model: "qwen3.6",
  capabilities: { vision: true }, // only if the specific model you've pulled actually supports it
});
```

Neither adapter probes the endpoint to guess what it supports — an
arbitrary OpenAI-compatible server has no standard capability-discovery
API. `capabilities` defaults conservatively (`vision: false` for
`OpenAICompatibleProvider`) and callers should set it based on the model
they've actually configured. Orchestration code branches on
`provider.capabilities` rather than assuming a method will work.

## Network status in this repository's sandbox

`OpenAICompatibleProvider` and `AnthropicProvider` are real, type-checked
implementations. Neither has been exercised against a live endpoint in this
repository's sandboxed dev environment — there's no local inference server
reachable here, and no `ANTHROPIC_API_KEY` configured. This is the same
disclosed-limitation category as `@reactfig/analyzer`'s Playwright browser
layer: real code, verified by type-checking and by every consumer that
*can* be tested doing so through `MockModelProvider`, but not live-called
here. See `docs/analyzer/ai-orchestration.md`, "Real model smoke test" for
how to actually run one against a local model.
