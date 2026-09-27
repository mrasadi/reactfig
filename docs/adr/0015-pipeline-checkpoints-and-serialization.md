# ADR 0015: Pipeline checkpoints and serialization-boundary enforcement (Phase 8)

## Status

Accepted

## Context

ADR-0012's Failure 4 investigation revealed a class of bug that no in-memory test could reproduce: a `DesignDocument` passed between `generate_design_ir` and `export_design_artifact` tools arrived with its `assets` field dropped (producing `args.document.assets is not iterable` deep in the asset-fetch loop) because the document traversed an MCP transport boundary as raw in-memory objects rather than through a concrete serialization round-trip. The pipeline historically treated the Design IR as a pure-in-memory transient value between tools, and any field loss at that boundary surfaced downstream as an opaque TypeError with no on-disk artifact to inspect or reproduce.

Additionally, `@reactfig/artifact`'s `pack()` carried a private copy of `stableStringify` (deterministic, sorted-key JSON serialization) while the new pipeline needed the same guarantee for checkpoint persistence — two implementations of "stable JSON" in the same repository, by design philosophy.

## Decision

Three changes:

### 1. Pipeline checkpoint system (`packages/mcp/src/checkpoint.ts`)

A new checkpoint module persists every major intermediate artifact of the `generate_design_ir` → `export_design_artifact` pipeline to disk as concrete, inspectable JSON inside a request-scoped directory:

- **Request-scoped directories:** `.reactfig/checkpoints/<requestId>/` under the project root (the same existing `.reactfig/` convention screenshots already use). Each generation gets its own directory; concurrent `generate_design_ir` calls cannot clobber each other's checkpoints. The `requestId` defaults to a deterministic slug of the component name but can be overridden (e.g., MCP request ID for concurrent calls).
- **Four stage files:** Each major pipeline stage writes one file:
  - `evidence.json` — the captured `ComponentEvidence` before any model work
  - `interpretation.json` — the AI model's interpretation result
  - `design-ir.json` — the constructed Design IR document
  - `validation.json` — the design-ir/v1 validation diagnostics for that document
- **Deterministic JSON:** All writes use `@reactfig/core`'s `stableStringify` (sorted keys, pretty-printed with 2-space indent) so every checkpoint file is byte-stable across runs. Reads use `stableParse`, ensuring write-then-read round-trips produce a structurally identical object.
- **Atomic writes:** Each file is written to a sibling temp file first, then renamed over the final path — a crashed write can never leave a partial JSON file masquerading as valid. Successful checkpoints are never deleted: if a later stage fails, earlier files remain on disk for debugging.
- **Validation gate:** `readValidatedDesignIr()` reads back a checkpointed design document and runs `validateDesignIR()` before it can be consumed by export — enforcing that the pipeline's "validate then persist" invariant holds at every boundary.

**Why this exists.** The explicit persistence turns the generate→export boundary from an invisible in-memory handoff into something inspectable: every stage writes a real JSON file, and export consumes a *reconstructed* document read back from disk rather than an in-memory object handed off across the tool-call boundary. If `assets` is missing or any required field was dropped, `readValidatedDesignIr()` throws a clear validation error naming the checkpoint path and diagnostics — enough to locate and fix the problem without re-invoking the model or browser.

### 2. Serialization-boundary enforcement at export (`packages/mcp/src/server.ts`)

The export handler now forces an explicit serialize→deserialize round-trip before validation and artifact generation:

```
args.document → normalizeDocumentArg → stableStringify → stableParse → assertDesignIR → export
```

This is the invariant that `generate_design_ir`'s result must survive a full JSON round-trip — the same deterministic JSON convention checkpoint writes to disk. Forcing the round-trip here, rather than trusting an in-memory object "happened to be returned by the previous tool call," makes fields lost in transit (like the `assets` undefined that produced `args.document.assets is not iterable`) surface as a real design-ir/v1 validation error instead of a raw TypeError deep in the asset-fetch loop.

The export handler also accepts and forwards a `requestId` to `generateDesignIrTool`, making checkpoints request-scoped even during concurrent calls. When an MCP client supplies its own request ID, that becomes the checkpoint directory name; otherwise it falls back to a deterministic slug of the component name.

### 3. Stable JSON consolidation into `@reactfig/core` (`packages/core/src/stableJson.ts`)

The private `stableStringify` implementation previously living only in `@reactfig/artifact` (used by `pack()` for deterministic `ir.json` and `manifest.json`) is now a shared module in `@reactfig/core`, exported as three functions:

- **`sortKeysDeep(value)`** — recursively sorts object keys at every nesting level, so JSON output is stable regardless of JavaScript runtime key ordering
- **`stableStringify(value)`** — deterministic, pretty-printed (2-space) JSON with sorted keys
- **`stableParse(text)`** — the mirror of `stableStringify`; a write-then-read round-trip produces a structurally identical object for plain JSON data

`stableStringify` preserves `generatedAt` and any other nondeterministic *values* the caller put in the data — it only normalizes key order, never values. This shared module means "deterministic JSON" means the same thing everywhere: both `@reactfig/artifact`'s `pack()` and the checkpoint layer use the same implementation.

## Consequences

- **Every stage of `generate_design_ir` is now on disk.** A mid-pipeline failure leaves concrete artifacts (`evidence.json`, `interpretation.json`, etc.) for debugging without re-running browser capture or model calls.
- **The generate→export boundary is explicit and inspectable.** Export consumes a reconstructed document from the checkpoint layer (or, equivalently in-memory: a full serialize→deserialize round-trip), not an in-memory object reference. Fields dropped in transit now surface as real validation errors with diagnostic detail.
- **Concurrent calls are safe.** Request-scoped checkpoint directories prevent concurrent `generate_design_ir` invocations from overwriting each other's stages.
- **Deterministic JSON is project-wide.** Both artifact packaging and checkpoint persistence share one implementation via `@reactfig/core`, eliminating the previous duplication of "sorted-key JSON" logic across packages.

## Verification

`packages/mcp/test/tools/generateDesignIr.test.ts` — new test `"persists each major stage to a request-scoped checkpoint directory"` asserts that all four stage files exist in the result's `checkpointDir` path after a successful run. `packages/mcp/test/pipeline.test.ts` — the chained pipeline test now uses `checkpointRootDir` pointing at a temp directory, verifying checkpoints work end-to-end through the full generate→export chain.

## What this does NOT do

- Does not read checkpoints back during export (the checkpoint directory is reported in `generateDesignIrTool`'s result as `checkpointDir`, and callers can use it — but export currently operates on the document passed to it, now enforced through an in-memory round-trip that is structurally equivalent to a disk round-trip)
- Does not clean up old checkpoints (they accumulate on disk; this is intentional — earlier stage files from a failed run must remain for debugging, and checkpoint lifecycle management is out of scope)
