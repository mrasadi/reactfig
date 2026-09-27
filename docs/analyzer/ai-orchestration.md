# AI orchestration (Phase 4)

How `@reactfig/analyzer` turns `ComponentEvidence` into a validated Design
IR document. For the architecture rationale and the decisions behind it,
see `docs/adr/0008-ai-orchestration.md`. This doc is the practical
reference: what to call, how to configure a provider, and how to run the
opt-in real-model smoke test.

## Usage

```ts
import { OpenAICompatibleProvider } from "@reactfig/model";
import { generateDesignIR } from "@reactfig/analyzer";

const provider = new OpenAICompatibleProvider({
  baseUrl: "http://localhost:11434/v1", // Ollama
  model: "qwen3.6",
  capabilities: { toolCalling: true, structuredOutput: true, vision: false },
});

const result = await generateDesignIR(provider, componentEvidence);
// result.document      — a design-ir/v1 DesignDocument
// result.validation     — { valid, errors } from @reactfig/core
// result.interpretation — the AI's ComponentInterpretation (for debugging)
// result.attempts        — 1 if it succeeded first try, >1 if repair ran
// result.toolCallCount   — how many get_evidence calls were made
```

`generateDesignIR` never throws for a validation failure — it returns the
last attempt with `validation.valid === false` so you can inspect
`validation.errors` and `result.interpretation` together. It only throws
for a genuine capability mismatch (`provider.capabilities.structuredOutput
=== false`).

## Configuring a provider for Qwen 3.6 (development target)

Qwen 3.6 needs no special-casing — served locally via Ollama, it's reached
through the same `OpenAICompatibleProvider` any other OpenAI-compatible
endpoint uses:

```ts
new OpenAICompatibleProvider({
  baseUrl: "http://localhost:11434/v1",
  model: "qwen3.6",
  capabilities: { toolCalling: true, structuredOutput: true, vision: false },
});
```

Set `vision: true` only if the specific Qwen build you've pulled actually
supports image input — capabilities are never auto-detected (see
`packages/model/README.md`).

## Real model smoke test (opt-in, not part of the default suite)

```bash
pnpm -r build
cd packages/analyzer

# Ollama / Qwen 3.6
ollama pull qwen3.6 && ollama serve
REACTFIG_SMOKE_BASE_URL=http://localhost:11434/v1 \
REACTFIG_SMOKE_MODEL=qwen3.6 \
node scripts/smoke-test-real-model.js   # compile scripts/*.ts first, or run via tsx/ts-node

# Anthropic
REACTFIG_SMOKE_PROVIDER=anthropic \
ANTHROPIC_API_KEY=sk-... \
REACTFIG_SMOKE_MODEL=claude-sonnet-5 \
node scripts/smoke-test-real-model.js
```

This script imports from built (`../dist`) output, matching
`packages/artifact/scripts/inspect-cli.ts` — Node's native TypeScript
type-stripping doesn't remap a `.js` import specifier to a sibling `.ts`
file, so `pnpm -r build` (or compiling the script itself) is required
before running it directly with `node`; `npx tsx scripts/smoke-test-real-model.ts`
works without a prior build if you have `tsx` available. It is not a
`.test.ts` file and is never run by `pnpm test` / `vitest run` — running
the repository's normal test suite requires no model, no API key, and no
local inference server.

## What the AI layer owns vs. what evidence owns

Restated from ADR 0008/0007 for a quick reference while reading
`src/ai/`:

| Evidence (deterministic) owns | AI (`ComponentInterpretation`) owns |
|---|---|
| bounds, computed CSS, colors, spacing | which prop combinations are real variants (evidence-constrained) |
| DOM hierarchy, text content | which wrapper elements are decorative (`skip`) |
| source props/types, componentPath | human-readable node/component names |
| asset URLs/metadata, viewport dimensions | — nothing else; see `buildDesignIR.ts` |

`buildDesignIR()` never reads a color, bound, or spacing value from
`ComponentInterpretation` — there's no field for it to read. This is
enforced by the schema shape, not by prompt instructions alone.

## Report: Phase 4 summary

- **Architecture**: two model-facing stages collapsed from the brief's six
  (`interpretComponent` handles source+visual+reconciliation in one
  tool-calling session; `buildDesignIR` is deterministic, never calls a
  model), plus validation and bounded repair. See ADR 0008.
- **Model capability handling**: `ModelProvider.capabilities` is required
  and explicit; `interpretComponent` branches on `toolCalling` and
  `vision`, `generateDesignIR` requires `structuredOutput` or throws
  immediately.
- **Tool-calling design**: one consolidated `get_evidence` tool
  (`kind: source|element|nested_component|viewport_capture|asset|screenshot`)
  bounded to `MAX_TOOL_ITERATIONS = 2` round-trips.
- **Vision strategy**: primary screenshot attached to the initial message
  only when `capabilities.vision`; additional screenshots available
  on-demand via the tool, never force-attached.
- **Evidence-selection strategy**: depth/component-boundary pruning
  (`buildInitialBundle`) — full detail for the target component, one-line
  summaries for nested component subtrees, metadata-only for non-default
  captures.
- **Structured-output strategy**: `ComponentInterpretation`, schema built
  per-request with variant values enum-constrained to evidence
  (`buildComponentInterpretationSchema`), plus a hard runtime
  re-check (`enforceVariantEvidence`) independent of provider schema
  support.
- **Validation/repair strategy**: `@reactfig/core`'s existing validator,
  bounded repair (default 2 retries) with validation errors fed back as
  repair context; gives up gracefully rather than looping forever.
- **Tests**: 97 tests in `@reactfig/analyzer`, all via `MockModelProvider`
  (no network); see ADR 0008's "Testing" section for the full breakdown by
  file. A separate opt-in smoke test exists for real-provider verification.
- **Known limitations**: nested-instance references are placeholder IDs
  (cross-component resolution deferred), box-shadow has no IR `Effect`
  translation (evidence itself doesn't parse it structurally), decorative
  "skip" only collapses single-child wrappers, repair re-runs the full
  tool loop rather than resuming mid-conversation. Full detail in ADR
  0008's "Known limitations".

## Explicitly not built in Phase 4

Per the brief: no Figma renderer, no Figma plugin changes. `generateDesignIR`
stops at a validated `design-ir/v1` document — the same document
`@reactfig/artifact` (Phase 5) will package and `@reactfig/figma-plugin`
(Phase 6) will render.
