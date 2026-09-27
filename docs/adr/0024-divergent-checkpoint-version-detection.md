# ADR 0024: divergent checkpoint version detection

## Status

Accepted. A direct response to a real, shipped failure: a user reported
a Dashboard render where every StatCard showed "1 / Missed sessions" and
every SessionCard showed "Dana Karimi / missed," regardless of position —
reproduced and root-caused against their actual uploaded checkpoints and
`.rfd`, not a synthetic report.

## Context

Root cause, confirmed directly from the uploaded checkpoint directory:
StatCard had FOUR checkpoint versions (`v001`–`v004`); SessionCard had
THREE. Each version's own `capture-plan.json` showed a single "default"
capture (`propValues: null`) against a DIFFERENT positional selector
(`:nth-of-type(1)`, `(2)`, `(3)`) — the signature of three/four SEPARATE
`generate_design_ir` calls, one per on-page position, instead of ONE call
using the `variants` argument (ADR 0019).

Each of those calls was, individually, exactly correct per ADR-0017 §2: a
genuinely different capture request against unchanged source legitimately
gets its own checkpoint version rather than being folded into an existing
one. The break is one layer up: `resolveCheckpointRef` (used by
`merge_design_ir_checkpoints` for the primary and every dependency)
silently resolves a component name to only its LATEST version. The other
versions' real, differently-captured evidence — StatCard's actual "12"
and "6.8" states, SessionCard's actual Amir/Sara instances — was simply
never looked at again, with nothing anywhere recording that it had ever
existed. Verified directly against the user's uploaded `.rfd`: all three
StatCard instances carry distinct stroke-color overrides (from
Dashboard's own per-instance capture, ADR-0020's independent mechanism)
but zero text overrides, because text differentiation depends entirely on
`buildInstanceOverridesFromPerInstanceData` matching against StatCard's
own single surviving checkpoint (v004) — which only ever held one state.

This is fundamentally a usage mistake (the `variants` argument exists
precisely to prevent it), not a bug in variant resolution or nested-
instance overrides (ADR-0020, still correct and unaffected). But the
pipeline had no way to notice it had happened, and shipped a visibly
broken artifact without a single warning anywhere in the merge report.

## Decision

`findDivergentSiblingVersions` (`checkpoint.ts`) detects the exact
structural signature of this mistake — not a semantic content diff,
which would mean reinventing "meaningfully different" (a notion this
project has good reasons not to guess at elsewhere either). Given the
version actually resolved, it flags another version of the same
component as a divergent sibling when:

- the resolved version's own design-ir is a plain `component`, not a
  `componentSet` (a componentSet means multi-variant capture already
  worked correctly — nothing to warn about);
- the sibling is ALSO a plain `component` (a sibling that's itself a
  componentSet is an unrelated generation, not this failure mode);
- the sibling's own capture used a DIFFERENT selector than the resolved
  version's.

`merge_design_ir_checkpoints` runs this for the primary and every
dependency (explicit or auto-discovered) and surfaces results in a new
`staleCheckpointVersionWarnings` field, with a message naming the
component, the versions involved, their selectors, and the fix (recapture
with one `generate_design_ir` call using `variants`).

## Consequences

- No false positives on any existing test or workflow: a component with
  only one version, a correctly-captured componentSet, or sibling
  versions that share a selector (a genuine re-run/resume of the same
  instance) all produce nothing. Verified directly against the reporting
  user's own checkpoint data (StatCard/SessionCard correctly flagged;
  Avatar — one version — correctly not flagged) before writing the unit
  tests.
- This does not, and cannot, recover the missing per-instance data —
  there is nothing safe to reconstruct from a checkpoint that only ever
  captured one state. It converts a silent, shipped-broken artifact into
  a loud, actionable warning at merge time, before export.
- Test suite grew from 624 to 630 (4 unit tests reproducing the exact
  real checkpoint-version pattern in `checkpoint.test.ts`, 2 end-to-end
  tests through the actual MCP tool call in
  `mergeDesignIrCheckpoints.test.ts`).

## What this doesn't cover

A caller could still ignore the warning and ship anyway — this is
detection and reporting, not a hard failure, consistent with how
`unresolvedExternalRefs` and `instanceOverrideWarnings` already work in
this same tool. A future version could optionally make this fatal (reject
the merge) behind a flag, if silent warnings prove not to be enough in
practice.
