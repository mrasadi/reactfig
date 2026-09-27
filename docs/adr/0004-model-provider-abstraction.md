# ADR 0004: Minimal model provider abstraction

## Status
Accepted

## Context
The brief called for a provider-agnostic model layer supporting Qwen,
Ollama, OpenAI, Anthropic, and custom providers, without over-building a
plugin framework.

## Decision
Define one `ModelProvider` interface:

```ts
interface ModelProvider {
  generate(input: GenerateInput): Promise<GenerateResult>;
  generateStructured<T>(input: StructuredInput<T>): Promise<T>;
  generateWithTools(input: ToolInput): Promise<ToolResult>;
  analyzeImage(input: ImageInput): Promise<GenerateResult>;
}
```

Ship exactly two reference adapters:

- `OpenAICompatibleProvider` — targets any `/v1/chat/completions`-shaped
  endpoint. This covers Ollama (and therefore local Qwen 3.6), OpenAI
  itself, and most self-hosted inference servers, with zero Qwen-specific
  code anywhere in the core.
- `AnthropicProvider` — targets the Anthropic Messages API shape, which is
  distinct enough to warrant its own adapter.

No plugin discovery system, no registry, no dynamic provider loading in v1.
A third provider is added by implementing the interface and passing an
instance in — that's the entire extension mechanism.

## Rationale
Two adapters are enough to prove the abstraction is real (two genuinely
different wire formats) without building infrastructure nobody has asked
for yet. "Qwen 3.6" specifically needs zero special-casing because it's
reachable through the OpenAI-compatible adapter via Ollama's compatible
endpoint.

## Consequences
- Users running Qwen (or any other model) via Ollama, LM Studio, vLLM,
  etc. work out of the box through `OpenAICompatibleProvider`.
- Adding a genuinely novel wire protocol later means writing one more
  adapter, not touching the interface.
