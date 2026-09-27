# ADR 0017: Checkpoint versioning, checkpoint map, Git awareness, and `diff_design_ir`

## Status

Accepted

## Context

ADR 0015 gave each `generate_design_ir` run one flat checkpoint directory
(`.reactfig/checkpoints/<requestId>/`) and explicitly scoped out anything
beyond that: multiple generations of the same component silently reused
(or collided with) the same directory unless the caller passed a distinct
`requestId` itself, there was no record of *what source state* produced a
checkpoint, and there was no way to compare two generations of a component
against each other short of diffing two JSON files by hand.

This becomes a real problem for the workflow ADR 0016's `merge_design_ir_
checkpoints` was designed for: a long-running session that generates
several components, gets interrupted (context window exhaustion, a new
Claude Code session), and needs to resume — or a component whose source
changes after it was captured, silently leaving a stale checkpoint that
looks current. Neither is detectable with ADR 0015's flat, unversioned,
source-blind checkpoint directories.

## Decision 1: versioned checkpoint directories, not a new persistence mechanism

Checkpoints now live at `.reactfig/checkpoints/<component>/v<NNN>/` — one
directory per *generation* of a component, not one per request. A new
`generate_design_ir` run for a component that already has checkpoints
never overwrites the latest one; it allocates the next version number
(`openVersionedCheckpointDir` in `checkpoint.ts`, with an `EEXIST`-retry
loop so two concurrent generations for the same component can't collide on
the same version directory). Historical versions are never deleted — they
remain available for `diff_design_ir` and for recovering the checkpoint
map (see Decision 3).

This builds directly on ADR 0015's existing mechanism rather than
replacing it: `writeCheckpoint`/`readCheckpoint`/`checkpointFile` and the
`stableStringify`/`stableParse`/atomic-write-via-temp-file-then-rename
approach are all unchanged — only what a `CheckpointDir` resolves to
changed (a specific version directory instead of a flat per-request one).

**Checkpoint version vs. other versions** (kept distinct per the original
spec, and reflected in the manifest schema below): `checkpointVersion`
(now `CHECKPOINT_LAYOUT_VERSION`, a constant bumped only if the on-disk
directory *layout* itself changes) is unrelated to a component's
generation number (`CheckpointDir.version`, 1/2/3/...), design-ir/v1's own
schema version, `PIPELINE_VERSION` (which build of `@reactfig/mcp`
produced it — previously a literal string duplicated inside
`generateDesignIr.ts`, now a single exported constant), and the source
file's own state (tracked separately — see Decision 2).

**Checkpoint reference syntax.** Every consumer of a checkpoint —
`merge_design_ir_checkpoints`, `diff_design_ir`, the optional
`checkpointRef` on `export_design_artifact` — addresses a checkpoint with
one small string: a bare component name (its latest version), `"Name@
latest"` (equivalent), or `"Name@vN"` for a specific historical version.
Resolution (`resolveCheckpointRef`) reads *directory names only* — it
never opens a manifest or design-ir.json just to figure out which version
is latest — so it works whether or not `checkpoint-map.json` (Decision 3)
exists, and is never at risk of drifting out of sync with it.

## Decision 2: a manifest per version, Git-enriched but never Git-dependent

Each version directory gets a `manifest.json` (`CheckpointManifest` in
`checkpoint.ts`) recording: which component, which source file, a
`sha256:` content hash of that file at generation time, the Git commit at
generation time *if Git was available*, which pipeline stages completed
(`sourceInspection` → `capture` → `interpretation` → `designIr` →
`validation` → `export`), which artifact files exist, and the validation
result — all answerable by reading one small JSON file, never the
(potentially large) `evidence.json`/`design-ir.json` it sits next to.

`git.ts` is new and deliberately minimal: `getCurrentGitCommit`,
`isFileDirty`, `getChangedFilesSince`, `hashFileContent`. Every function
except `hashFileContent` degrades to `undefined` rather than throwing —
not a git repo, `git` not on `PATH`, no commits yet, a timeout, all treated
identically as "no Git context available right now". `hashFileContent`
(sha256 of the file's actual bytes, no Git involved) is the one hard
requirement: it's what makes staleness detection work identically with or
without Git, and what catches uncommitted local edits a commit hash alone
would miss. The project keeps working, unchanged, with no Git repository
present at all.

**Staleness is a direct hash comparison, nothing fancier.** Per the
original spec's explicit "do not over-engineer source invalidation": there
is no dependency graph. A caller comparing a checkpoint's recorded
`source.contentHash` against a fresh `hashFileContent()` of the current
file gets a yes/no answer. A stale checkpoint is never deleted — like any
other historical version, it stays available for `diff_design_ir` to
compare against what replaced it.

Manifests are written incrementally as each stage actually completes
(`patchManifest`, a read-merge-write that only updates the stages/
artifacts/validation fields given, never reverting an earlier stage) —
never all at once at the end, and never marking a stage `"completed"`
before its artifact file has been durably written by `writeCheckpoint`.

## Decision 3: `checkpoint-map.json` is a disposable index, never authoritative

`checkpointMap.ts` is a new, separate module — not folded into
`checkpoint.ts` — specifically so `checkpoint.ts`'s own version
allocation/resolution never depends on it (no circular dependency, and no
risk of the low-level checkpoint mechanism breaking if the map is
missing or corrupt). It exists for exactly one job: letting a reader (a
resumed agent session, primarily) answer "what's the latest checkpoint
for each component, what stage did it reach, is it stale" by reading one
small file, instead of listing every component's checkpoint directory and
opening its latest manifest.

It is emphatically not the source of truth — each version's own
`manifest.json` is. If `checkpoint-map.json` is missing, stale, or
corrupted, `rebuildCheckpointMap` reconstructs it by scanning
`.reactfig/checkpoints/<component>/v<N>/manifest.json` for each
component's *latest* version only (never reading `evidence.json`/
`design-ir.json`), and is safe to run at any time. Updates
(`upsertCheckpointMapEntry`) happen only after a checkpoint write already
succeeded, using the same atomic temp-file-then-rename pattern as
`writeCheckpoint` itself. A crash between a checkpoint write and the
matching map update just leaves the map temporarily behind reality —
recoverable via rebuild, never corrupting the checkpoints themselves.

**Accepted risk, deliberately not engineered around**: two *different*
components' map updates racing each other is a real possibility (a
read-modify-write of the whole file, not a per-component patch) at this
project's stated scale. The worst case is one update briefly overwriting
another's, self-healed by either component's next write, and always fully
recoverable via `rebuildCheckpointMap`. Building file locking or a
per-component map shard for this would be exactly the kind of
over-engineering the original spec explicitly asked to avoid.

The map never stores a full Design IR document — only a path to it
(`entry.designIr`, relative to the project root) — kept deliberately small
(tested directly: a real checkpoint's distinctive content never leaks into
the map file).

## Decision 4: `diff_design_ir` is id-matched and semantic, not a JSON diff

`@reactfig/core`'s new `diff.ts` (not `packages/mcp` — this is a Design IR
concern, belongs with `merge.ts`/`validate.ts`) compares two documents by
matching pages/components/variants/nodes by their stable `id` fields at
every level, never by array index — the same identity strategy `merge.ts`
already uses for this document shape, not a second, different one. This is
what makes a reordered (but otherwise unchanged) sibling report as nothing
(or, for a pure reorder with no other change, a single minor "children
(order)" entry) instead of a misleading "node 3 removed / node 3 added".

Categories (`structure`/`layout`/`bounds`/`typography`/`fills`/`strokes`/
`effects`/`assets`/`instances`/`variants`/`pages`/`metadata`) and severity
(`major` for anything that changes *what exists* — additions, removals, a
type change, a componentRef repointing, a variant axis change; `minor`
for everything else) follow simple, category-based rules rather than an
invented numeric threshold on e.g. "how many pixels of bounds change counts
as major" — deliberately, to avoid a second form of over-engineering.
`meta.generatedAt` is never compared — it differs on literally every
generation and carries no design meaning; comparing it would make every
diff between two otherwise-identical documents report a spurious change.

The `diff_design_ir` MCP tool (`packages/mcp/src/tools/diffDesignIr.ts`)
is checkpoint-aware without adding a second diff engine: each side is
given as either an inline document or a checkpoint reference (identical
`"Name"`/`"Name@latest"`/`"Name@vN"` syntax to `merge_design_ir_
checkpoints`), resolved the same way, so comparing `SessionCard@v1` to
`SessionCard@v2` is one tool call with two small strings — never two large
JSON documents pasted inline. The result includes both the structured
`entries`/`summary` (for programmatic use) and a rendered `report` string
(`formatDesignIrDiff`, category-grouped, `before → after` per changed
path) for a human or agent reading the response directly.

## Consequences

- Every existing consumer of checkpoints (`merge_design_ir_checkpoints`,
  `export_design_artifact`'s optional new `checkpointRef` bookkeeping
  parameter) now speaks in checkpoint *references*, not flat ids —
  `mergeDesignIrCheckpoints.ts` was updated accordingly, including
  recording exactly which resolved refs (`component@vN`) went into a
  merge as that merged checkpoint's own manifest `source`.
- `generateDesignIr.ts`'s result shape changed: `requestId` (an
  MCP-request-scoped id, previously used only to avoid directory
  collisions) is gone, replaced by `checkpointVersion` and `checkpointRef`
  — a more useful pair, since versioning itself now prevents collisions
  without any caller-supplied id.
- 40 new tests across `checkpoint.test.ts` (versioning + manifest, 17
  total), `checkpointMap.test.ts` (8), `git.test.ts` (9), `diff.test.ts`
  in `@reactfig/core` (16), `diffDesignIr.test.ts` (6), plus additions to
  `mergeDesignIrCheckpoints.test.ts` and `mcpBoundary.test.ts` — full
  monorepo suite (330 tests across all 6 packages) passing, build and
  typecheck clean.

## What this deliberately does NOT do

Per the original spec's explicit "keep it simple" priority:

- No database, no event sourcing, no background workers, no new package
  (`checkpointMap.ts`/`git.ts`/`diff.ts` all live in the existing
  `packages/mcp`/`packages/core` — the same two packages ADR 0015/0016
  already used).
- No dependency-graph-based staleness — a direct content-hash comparison
  only (Decision 2).
- No file locking or sharding for `checkpoint-map.json` — accepted,
  self-healing, rebuildable risk instead (Decision 3).
- No tree-edit-distance or other sophisticated diff algorithm — stable-id
  matching is sufficient because the format already has stable ids
  end to end (Decision 4).
- `export_design_artifact` does not gain checkpoint-*reading* support (a
  `checkpointRef` input alongside `document`) — only checkpoint-*writing*
  bookkeeping (marking an already-known checkpoint's export stage done).
  Extending it to resolve a checkpoint reference directly, the way
  `merge_design_ir_checkpoints`/`diff_design_ir` do, is a natural follow-up
  if the same inline-JSON friction shows up there, but wasn't required by
  anything in this change.
