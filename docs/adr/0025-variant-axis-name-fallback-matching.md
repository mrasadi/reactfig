# ADR 0025: variant axis name fallback matching

## Status

Accepted. Found by directly reproducing a user-reported failure against
this project's own MCP tool with real checkpoint shapes — not inferred
from a bug report alone. A separate AI agent had traced partway into the
same symptom (all StatCard/SessionCard instances defaulting to variant
v0) and stopped mid-investigation without finding the actual cause; its
transcript's specific code trace (a `hasExplicitDeps`/`hasNewAutoResolved`
gating condition) does not match this codebase and was not the real
cause — reproducing directly against the real tool, rather than trusting
that trace, is what found the actual bug below.

## Context

`assignVariantsFromPerInstanceData` (ADR-0020) selects each instance's
variant by looking up `item[axis.name]` — the componentSet's own
confirmed variant axis name — directly as a key in that instance's
`perInstanceData` item. This assumes the two agree on naming. They don't
have to: `axis.name` comes from AI interpretation of captured evidence
(ADR-0008), while `perInstanceData`'s own field names come from the raw
source data (a `STATS`/`SESSIONS` array's literal field names). Nothing
connects these two naming processes.

Reproduced directly: a componentSet whose confirmed axis is `"cardTone"`
(a plausible interpretation-step choice) merged against `perInstanceData`
whose own field is `"tone"` (matching the source's actual field name) —
every instance silently defaulted to `variants[0]`, with **zero warning**
anywhere in the merge result. The existing "no captured variant has that
value" warning never fires in this case, because `item[axis.name]` is
`undefined`, not a mismatched string — a completely different, previously
unhandled branch of the same function.

## Decision

When `item[axis.name]` isn't a string, look for exactly one field in that
item whose *value* is one of the axis's own already-known values
(`axis.values`, populated from what was actually captured — see
`buildComponentSet`). This is safe because it never invents a value; it
only recognizes a value the axis itself already declared valid, appearing
under a different field name than expected.

- Exactly one such field → use it, no guessing involved.
- Zero such fields → warn, naming both the missing axis and the values it
  was looking for, and leave the instance on its current variant.
- More than one such field → warn that the match is ambiguous and leave
  the instance on its current variant, rather than picking one
  arbitrarily.

## Consequences

- No behavior change for the common case (axis name and data field name
  already agree) — verified by the full existing merge.test.ts suite
  passing unchanged.
- A genuine axis/field naming mismatch, previously 100% silent, is now
  either transparently recovered (unambiguous case) or loudly flagged
  (ambiguous/absent case) — never silently wrong without a trace.
- 3 new tests added (unambiguous recovery, absent-with-no-fallback,
  ambiguous-with-two-candidates), reproducing the exact real-world
  scenario found. Test suite grew from 630 to 633.
