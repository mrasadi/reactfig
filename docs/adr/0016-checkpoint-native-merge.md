# ADR 0016: Checkpoint-native merge + auto-export (`merge_design_ir_checkpoints`)

## Status

Accepted

## Context

ADR 0015 gave every pipeline stage a concrete on-disk checkpoint
(`evidence.json`, `interpretation.json`, `design-ir.json`,
`validation.json` under `.reactfig/checkpoints/<requestId>/`) but
explicitly scoped out reading them back in: its "What this does NOT do"
section notes that "export currently operates on the document passed to
it," not on a checkpoint the client points it at.

`merge_design_ir_documents` (ADR 0008) inherited that same shape: its
`primary` and `dependencies` arguments are `z.unknown()` — the calling
client is expected to hold each `generate_design_ir` result in memory (or
re-read the checkpoint file itself) and pass the full `DesignDocument`
JSON inline as tool-call arguments. For one dependency this is a minor
inconvenience. For a composite component with several nested
dependencies — the exact scenario `merge_design_ir_documents` exists for
— it means the client (an LLM agent, in the common case) has to hold
every dependency's full Design IR in its own context window at once, and
reproduce it byte-for-byte as JSON-RPC arguments, just to call one tool.
That's expensive in tokens, easy to get subtly wrong (truncation,
re-serialization drift), and pushes real users toward exactly the
workaround this project's own design explicitly avoids elsewhere: a
hand-rolled Node/shell script that reads the checkpoint files off disk
and does the merge outside the MCP boundary, or a second, less-tested
inference call to reconstruct the JSON before invoking the tool.

## Decision: `merge_design_ir_checkpoints`, not a change to `merge_design_ir_documents`

Added a new tool rather than changing the existing one's argument shape,
so `merge_design_ir_documents` keeps working unmodified for a client that
already has both documents in memory (e.g. two `generate_design_ir`
calls in the same turn, no checkpoint lookup needed) — the smallest-surface
principle from ADR 0010 applies here too: don't overload one tool's
input contract with two incompatible shapes when a second, differently-
scoped tool says exactly what it does.

`merge_design_ir_checkpoints` takes `primaryCheckpointId` and
`dependencyCheckpointIds: string[]` — the same request-scoped ids
`generate_design_ir` already produced and left under
`.reactfig/checkpoints/<id>/design-ir.json` — instead of full documents.
It:

1. Reads each checkpoint via `readValidatedDesignIr` (ADR 0015's existing
   read-and-validate helper — no new reconstruction logic).
2. Merges them with the same `@reactfig/core` `mergeDesignDocuments`
   `merge_design_ir_documents` already uses — identical resolution
   semantics (`external:<n>` rewriting, id namespacing, duplicate
   detection), just a different input path. No merge logic is
   duplicated.
3. Persists the merged document as its own checkpoint
   (`.reactfig/checkpoints/merged-<primaryCheckpointId>/` by default, or
   `mergedCheckpointId` if the caller wants a specific name) via
   `writeDesignIrAndValidation` — so the merge step is on disk and
   inspectable exactly like every other stage ADR 0015 established, not
   a one-off exception.
4. Unless `exportArtifact` is explicitly `false`, reloads that merged
   checkpoint (not the in-memory `mergeResult.document` reference — the
   same explicit serialize→disk→deserialize boundary ADR 0015 §2
   enforces for `export_design_artifact`'s own handler) and calls
   `exportDesignArtifactTool` directly, in-process — not a second MCP
   round trip — producing the final `.rfd` in the same tool call.

## Decision: a new read-only `resolveCheckpointDir`, not a repurposed `openCheckpointDir`

`openCheckpointDir` creates the target directory (`mkdir -p`) because
every existing caller uses it right before *writing* a checkpoint. A
caller that only wants to *read* a checkpoint an earlier call already
wrote (this tool's primary/dependency lookups) should not silently
create an empty directory when the id is wrong or the checkpoint was
never generated — that would turn a typo'd id into a confusing "file not
found inside a directory that mysteriously now exists" instead of a
direct error. `resolveCheckpointDir` is a pure path computation (no
filesystem access at all); `readCheckpoint`/`readValidatedDesignIr`
already throw a clear, path-inclusive error when nothing is there, so
the failure mode for a bad id is unchanged and still legible.

## Consequences

- A client merging a composite component with N nested dependencies now
  makes one tool call passing N small string ids, not N full JSON
  documents. This is the primary goal: no external script, shell, or
  extra model/tool-calling loop is needed to read checkpoint files and
  glue merge + export together outside the MCP boundary.
- The merge step gets its own on-disk checkpoint
  (`merged-<primaryCheckpointId>/design-ir.json`), which was not
  previously true for `merge_design_ir_documents` — a merged document
  only ever existed in the tool-call response and whatever the client
  did with it next. This closes part of the gap ADR 0015 flagged as
  future work.
- `merge_design_ir_documents` is unchanged and still the right choice
  when documents already exist as in-memory values with no checkpoint
  backing them (e.g. hand-constructed or edited via `validate_design_ir`
  first).
- 4 new tests (`packages/mcp/test/mergeDesignIrCheckpoints.test.ts`),
  through the real MCP dispatch boundary (`connectedClient()`, the same
  pattern `mergeDesignIrDocuments.test.ts` uses): end-to-end merge +
  export + `.rfd` unpack, default `merged-<id>` checkpoint naming with
  `exportArtifact: false`, a missing-checkpoint-id error case, and the
  componentSet/variant resolution path already covered for
  `merge_design_ir_documents`.

## What this does NOT do

- Does not add checkpoint-id support to `export_design_artifact` itself
  — a caller exporting a single, non-merged checkpoint still passes its
  document inline (or reads the checkpoint file itself first). Only the
  merge path, where the multi-document JSON-plumbing cost is highest,
  was addressed here; extending checkpoint-id input to
  `export_design_artifact` directly is a natural follow-up if the same
  friction shows up there.
- Does not clean up the merged checkpoint or any checkpoint it read from
  — consistent with ADR 0015's existing "checkpoints are never deleted"
  decision; checkpoint lifecycle management remains out of scope
  project-wide.
- Does not change `merge_design_ir_documents`'s inline-JSON contract in
  any way.
