# ADR 0014: `generateStructured` reliability and the `textAlign` IR-construction bug

## Status
Accepted

## Context

A real `generate_design_ir` invocation (OpenCode → ReactFig MCP →
LiteLLM → Ollama → a `vision`-capable local model at
`http://localhost:4000/v1`) surfaced two distinct, unrelated bugs in the
same run:

1. The model's final structured-output call returned Markdown/prose
   instead of JSON despite `response_format: json_schema` being set —
   `generateStructured` had no fallback and no validation, so this
   surfaced downstream as an unparsable-JSON error.
2. Once structured output did succeed, `buildDesignIR`'s construction of
   the Design IR produced a document that failed Ajv validation with
   **1340 errors**.

This ADR documents both root causes and fixes as found by tracing the
actual code, not by assumption.

## Bug 1: `generateStructured` did not guarantee JSON

### Root cause

`OpenAICompatibleProvider.generateStructured` (`packages/model/src/
providers/openaiCompatible.ts`) sent `response_format: { type:
"json_schema", ... }` as a *request* to the backend, then did:

```ts
const text = extractText(response.choices[0]?.message);
const value = JSON.parse(text) as T;
```

`response_format` is a hint an OpenAI-compatible/LiteLLM backend and the
underlying model are free to ignore — and, per the real report, did:
the model returned prose like `"I have enough evidence... ##
ComponentInterpretation — \`SessionCard\`..."`. `JSON.parse` on that
throws immediately, with nothing upstream having attempted recovery or
validated anything.

### Fix

A new shared module, `packages/model/src/structuredOutput.ts`, used by
both `OpenAICompatibleProvider` and `AnthropicProvider`:

- **`extractJsonCandidate(text)`** — tries, in order: (1) the whole
  string as JSON directly, (2) a fenced code block (```` ```json ... ``` ````
  or plain ```` ``` ... ``` ````) — the single most common way an
  instruction-tuned model "helpfully" wraps JSON despite being asked for
  raw structured output, (3) a balanced `{...}` span found anywhere in
  the text. Returns `undefined`, not a best guess, when none of these
  produce syntactically valid JSON — this is a hard boundary: the
  function never attempts to parse arbitrary Markdown *structure* (e.g.
  a heading, a bullet list) as if it were meaningful data.
- **`validateStructuredOutput(value, schema)`** — validates the
  extracted candidate against the caller's actual JSON Schema via Ajv
  (`strict: false`, since schemas here come from call sites outside this
  package, not from `@reactfig/core`'s own strict-mode-compiled schema)
  before anything is accepted as the result.
- **One bounded retry, never indefinite.** `OpenAICompatibleProvider
  .generateStructured` now makes at most 2 attempts total: if attempt 1
  fails to extract or fails validation, attempt 2 appends one corrective
  user message naming exactly what was wrong ("not parseable as JSON at
  all" or the specific Ajv errors) and asks again. If attempt 2 also
  fails, it throws a clear, specific error — including the schema name,
  the failure reason, and the first 200 characters of the last raw
  response — rather than silently returning prose or fabricating a
  best-effort JSON shape. This mirrors the existing bounded-repair
  pattern `generateDesignIR`'s orchestration loop already uses for
  invalid IR (see ADR 0008) — the same philosophy applied one layer
  earlier, at the raw-response boundary.
- **`AnthropicProvider.generateStructured`** gets the identical
  validate-then-bounded-retry treatment, as defense-in-depth. Its
  `tool_choice`-forced approach (a synthetic tool whose `input_schema`
  *is* the requested schema) is inherently far less likely to return
  prose than a generic OpenAI-compatible endpoint, but the tool's
  `input` is still model-generated content — the Anthropic API does not
  itself guarantee every constraint in an arbitrary JSON Schema (enums,
  cross-field `required` combinations, etc.) is satisfied, so validating
  before returning is correct here too, not redundant.

`GenerateStructuredResult<T>` and the `ModelProvider` interface are
unchanged — this is purely an internal reliability fix at the provider
boundary; nothing in `@reactfig/analyzer`'s orchestration layer needed
to change to benefit from it.

## Bug 2: the Design IR construction produced ~1340 validation errors

### Root cause

`buildDesignIR.ts`'s `mapTextNode` did an unchecked type assertion:

```ts
textAlign: (t.textAlign as Typography["textAlign"]) ?? undefined,
```

`t.textAlign` is the **raw CSS computed value**, captured verbatim by
`interpretDomSnapshot.ts` (`textAlign: cs["text-align"] ?? null`) —
correctly so, per ADR 0007/0008's principle that deterministic evidence
must never be silently reshaped; mapping into the IR's domain is
construction's job, not evidence's. But `design-ir/v1`'s
`Typography.textAlign` is a closed 4-value enum: `left | center | right
| justify`. The unchecked cast let any raw CSS value straight through
unvalidated.

**`text-align: start` is the CSS *initial* value in every modern
browser** (Chromium, Firefox, Safari) — meaning any text node that never
had `text-align` explicitly set reports `"start"` from
`getComputedStyle`, not `"left"`. That's the overwhelming majority of
real UI text (labels, timestamps, body copy — anything not deliberately
centered or right-aligned). `"start"` is not in the enum, so essentially
every such `TextNode` failed schema validation.

The error count amplification is explained by how Ajv reports a failed
`oneOf`: `design-ir/v1`'s `Node` type is `oneOf: [FrameNode, GroupNode,
TextNode, ShapeNode, ImageNode, InstanceNode]`, each with
`additionalProperties: false` and its own `required` list. With
`allErrors: true`, when a value matches none of the six branches, Ajv
reports the failure for **every branch it tried** — for a text node
whose only real defect is `typography.textAlign`, that means one
genuine error (`textAlign` not in the enum, checked against the
`TextNode` branch) plus five pieces of misleading noise: "must have
required property 'children'" (checked against `FrameNode`/`GroupNode`,
which require `children`), "must have required property 'shape'"
(`ShapeNode`), "must have required property 'assetId'" (`ImageNode`),
"must have required property 'componentRef'" (`InstanceNode`), plus a
top-level "must match exactly one schema in `oneOf`". That's roughly
six error lines per single bad node — which lines up almost exactly with
1340 errors across a real component tree with hundreds of text nodes,
confirming this one defect as the dominant (very plausibly sole) cause.

This went undetected by the existing test suite because every existing
fixture (`button-default.json`, `session-card.json`) hand-authors
`text-align` as `"center"` or `"left"` — values already inside the
enum — never the real-world `"start"` default a live browser actually
produces.

### Fix

A new `mapTextAlign(raw: string | null): Typography["textAlign"]` in
`buildDesignIR.ts`:

- `"left"` / `"start"` → `"left"`
- `"right"` / `"end"` → `"right"`
- `"center"` → `"center"` (unchanged)
- `"justify"` → `"justify"` (unchanged)
- anything else (`"match-parent"`, `"inherit"`, `"initial"`, `"unset"`,
  or an unrecognized future CSS value) → `undefined` (omitted)

`start`/`end` → `left`/`right` is a defensible, standard default for the
overwhelmingly common left-to-right case — the evidence layer doesn't
currently capture element directionality (`dir`/`writing-mode`) to do
better than that, and adding that is out of scope for this fix. For
genuinely ambiguous values, omitting is deliberate and correct rather
than guessing: `textAlign` is *optional* in the schema, so "no opinion"
is a fully valid, honest answer. Fabricating a specific enum value here
would be exactly the kind of unevidenced invention ADR 0008 rules out —
this fix makes the point that the rule applies to construction code, not
only to the model.

Every other enum/required-property mapping in `buildDesignIR.ts` was
audited against the actual schema and evidence types as part of this
investigation (`Layout.mode`, `padding`, `Color`, `CornerRadius`,
`Fill`, `Stroke`) — all were already correctly bounded, either via a
`switch` with an explicit default or a type that structurally can't
produce an invalid shape. `textAlign`'s unchecked cast was the one gap.

## What this does NOT do

- Does not change `design-ir/v1`'s schema, `ComponentInterpretation`'s
  schema, or Ajv's strictness in any way — both bugs were fixed entirely
  within the model-provider boundary and the deterministic construction
  layer.
- Does not add directionality/`writing-mode` evidence capture — `start`/
  `end` are mapped with a stated LTR-default assumption, not resolved
  precisely. A future enhancement could capture computed `direction` and
  map `start`/`end` accordingly; not done here since nothing in the
  reported failure required it.
- Does not retry indefinitely, weaken any schema to make a response
  pass, or accept a value that fails validation — both fixes fail loudly
  with a specific, diagnosable error after exactly one bounded corrective
  attempt.

## Verification

`packages/analyzer/test/ai/buildDesignIR.test.ts` — new tests build a
hand-authored `RawDomSnapshot` with `text-align: "start"` (and `"end"`,
and several ambiguous values) through the real `interpretDomSnapshot` →
`buildDesignIR` → `validateDesignIR` pipeline, asserting `valid: true,
errors: []` — the exact failure mode reported, reproduced and fixed, not
just unit-tested in isolation.

`packages/model/test/openaiCompatible.test.ts`,
`packages/model/test/anthropic.test.ts`, and `packages/model/test/
structuredOutput.test.ts` — cover direct-JSON success, fenced-block
recovery, bare-object-in-prose recovery, the exact reported pure-Markdown
failure (recovers via retry, or throws a clear error if the retry also
fails), and schema-validation failures on syntactically-valid-but-wrong
JSON, for both providers.
