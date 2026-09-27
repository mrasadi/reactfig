# ADR 0026: Interactive Capture Mode

## Status

Accepted, with the same kind of explicit, load-bearing caveat as ADR
0023: the browser-facing half of this feature (the injected overlay's
hover highlighting, Shadow DOM isolation, and survival across real SPA
navigation) has NOT been exercised against a real browser. This
environment has no network access to a Playwright browser binary, so
there is nothing to load the overlay into. Every part of this feature
that does not require an actual browser — the manifest lifecycle,
`CollectionSession`'s persistence (including a simulated process-restart-
and-resume), the fiber-walk boundary resolution, and the full start →
select → remove → navigate → finalize → `generate_design_ir_from_capture`
workflow — was verified by a real test run before being called done,
using a fake browser attachment in place of Playwright (the same seam
`GenerateDesignIrContext.captureComponent` already uses for
`generate_design_ir`'s own tests). The browser-glue code itself
(`collection/collectionBrowser.ts`, `collection/overlayScript.ts`) is
written against Playwright's documented API and kept as thin as possible
specifically so the untested surface is small, but it needs real-browser
QA before production use.

## Context

Every existing evidence-acquisition path (`generate_design_ir`,
`find_component_selector`) requires the caller to already know a
`url`/`selector` up front. For a component whose interesting state is
behind a login, several clicks into a flow, or only reachable after an
API call settles, describing that target ahead of time is often harder
than just clicking on it once you're there. Interactive Capture Mode
exists to let a developer reach the exact state they want by using the
application normally, then pick the target visually — DevTools-style —
instead of guessing a selector.

This is entirely new, optional infrastructure. It does not replace
`generate_design_ir`'s existing entry point, and nothing about normal
usage changes if a client never calls these tools.

## Decision 1: a collection is not a checkpoint, and lives in a sibling directory

`.reactfig/checkpoints/<component>/v<N>/` (`checkpoint.ts`) represents
*processed pipeline state* for a specific, named component — evidence,
interpretation, Design IR, validation, one version per generation.
`.reactfig/collections/<id>/` represents *raw developer-selected
evidence*, gathered before any component identity or pipeline stage is
involved — a single collection can (and typically does) span several
different components across several pages. Folding collections into the
checkpoint system would have meant either inventing a fake "component
name" for a collection that might contain a dozen unrelated components,
or bolting a second identity scheme onto checkpoint directories. Keeping
them as siblings under `.reactfig/` makes the boundary a fact about the
filesystem, not just something described in a comment: a collection is
consumed exactly once (by `generate_design_ir_from_capture`, which then
produces an ordinary checkpoint per component, same as any other
`generate_design_ir` call) and is never itself versioned or diffed.

The persistence pattern — atomic write-then-rename, a manifest that's
patched incrementally rather than rewritten, never deleting a completed
unit of work (a removed selection is marked `"removed"`, not erased) — is
deliberately copied from `checkpoint.ts` and `capturePlan.ts`. Reusing the
*pattern* without reusing the *module* was the right call here: those
modules' write paths are keyed on `CheckpointDir`/`CheckpointName`, a
fixed enum inside a component+version directory, which a collection's
files (one manifest, N selection subdirectories with two files each)
don't fit.

## Decision 2: component-boundary resolution reuses the existing fiber walk, run outward instead of by name

`findComponentInstances.ts` already answers "which DOM elements are the
root of an instance of component X" by walking each candidate element's
`_debugOwner` fiber chain and comparing nearest-owner names. Interactive
Capture needs almost the identical operation, just inverted: given one
already-known DOM node (whatever the developer clicked), find the
nearest enclosing element whose nearest owner differs from its own
parent's — the same `isComponentRoot` boundary `interpretDomSnapshot.ts`
already computes for evidence capture, computed outward from a single
starting point instead of over an entire captured tree.

`@reactfig/analyzer`'s new `resolveComponentBoundary` implements exactly
this, and nothing more: `direction: "root"` walks up from a click to the
nearest boundary; `"parent"` continues outward to the *next* enclosing
instance; `"child"` walks in from a resolved boundary to find the first
nested instance. All three are pragmatic, MVP-scoped: no attempt is made
to disambiguate a self-recursive component (documented limitation,
inherited from `findComponentInstances.ts`, which has the identical
gap), and a click with no React ownership info at all (production build,
non-React DOM) degrades to the raw clicked element rather than failing —
the overlay's "↑ Parent"/"↓ Child" buttons exist specifically so a wrong
guess is a one-click correction, not a failed capture.

This function is duplicated (not imported) from `findComponentInstances.ts`'s
own fiber-walk helpers, for the same reason `collectDomSnapshot.ts` and
`findComponentInstances.ts` already duplicate each other:
`page.evaluate`/`page.addInitScript` serialize a function via
`Function.prototype.toString()` and run only that function's own source
inside the page — there is no way to share code across that boundary. The
overlay embeds `resolveComponentBoundary.toString()` directly rather than
re-implementing the walk a fourth time by hand, which at least keeps the
overlay's copy and `@reactfig/analyzer`'s tested copy identical by
construction.

## Decision 3: evidence is captured at confirm time, and the browser owns nothing after that

The most important data-model decision in this feature: when the
developer clicks Confirm, the full evidence a `generate_design_ir` call
would need — a `RawDomSnapshot` via `collectDomSnapshot` and a screenshot
via `Locator.screenshot()` — is captured and persisted immediately, not
deferred until finalization and reconstructed from a remembered selector.
A selector is only guaranteed to resolve to the intended element at the
instant it was computed; capturing evidence later, from a possibly-stale
selector after further navigation or application state changes, would
reintroduce exactly the kind of ambiguity `generate_design_ir`'s own
`matchCount`/`verifyCapturedOwner` machinery already exists to catch for
live captures. Capturing immediately sidesteps the problem entirely, and
is what makes "the browser can be closed after finalization, and nothing
downstream depends on it" a structural fact rather than a hope.

## Decision 4: the browser overlay never captures evidence itself, and never persists anything

The injected overlay (`collection/overlayScript.ts`) does exactly three
things: highlight whatever's under the cursor, resolve a click to a
component boundary (via the embedded `resolveComponentBoundary`), and
show a small floating preview/log UI. It cannot take a screenshot or read
computed styles at the fidelity `collectDomSnapshot` needs — those need
Playwright's own Node-side API, not something achievable from inside the
page's own JS context — so it never tries to. On Confirm, it sends a
small payload (selector, componentPath, tag, rect, url, page title) to
Node via `page.exposeFunction`; Node (`collectionBrowser.ts`) does the
actual capture and hands it to `CollectionSession`, which is the only
thing that ever writes to `.reactfig/collections/`. This keeps "no AI
interpretation happens in the browser, and the browser doesn't own
persistence" a property of which process does the writing, not just a
rule stated in a comment.

`page.exposeFunction` was chosen over a local WebSocket/HTTP server (a
new listening port, a new failure mode) or filesystem polling (awkward
for genuine click *events*, and adds latency for what should feel
DevTools-instant) — it rides the same CDP connection
`createPlaywrightSession` already holds open, needs no new dependency,
and keeps the whole browser/Node boundary inside Playwright's own
supported API.

## Decision 5: start/status/finalize, not one long-running MCP call

ADR 0013 already documents a real, previously-encountered MCP client
timeout on a call that only took "well over a minute" of *fully
automated* work. A call that blocks for an arbitrarily long, human-paced
browsing session — the developer might step away for lunch mid-collection
— is the same problem with no upper bound at all. `start_interactive_capture`
returns as soon as the browser is attached; `get_interactive_capture_status`
is a plain, side-effect-free manifest read; `finalize_interactive_capture`
is the only call that ends the collection. This also gives resumability
"for free": since a collection's only durable state is its on-disk
manifest, `CollectionSession.resume` reopening the same directory from a
brand new process is not a special case, it's just what always happens
when a client calls the tool from a different request than the one that
started the session — including, if necessary, after this server process
itself restarted.

## Decision 6: `generate_design_ir_from_capture` is the entire integration surface, and `generate_design_ir` itself is untouched

`GenerateDesignIrContext.captureComponent` was already an injected
`(request: CaptureRequest) => Promise<RenderCapture>` dependency (the
production default drives Playwright; tests already inject a fake one).
`collection/collectionCapture.ts`'s `createCollectionCapture` implements
that exact same contract by reading a selection's persisted
`RawDomSnapshot` and running it through the same `interpretDomSnapshot`
every live capture already uses, instead of touching a page at all.
`generate_design_ir_from_capture` resolves a selection's own recorded
`url`/`selector` from the finalized manifest, builds this alternate
`captureComponent`, and calls the completely unmodified
`generateDesignIrTool` — every downstream stage (evidence assembly, AI
interpretation, Design IR construction, checkpointing, merge, export)
runs the identical code path a normal `generate_design_ir` call runs.
There is no mode-switching inside `generateDesignIrTool` itself, no
second checkpoint/diff/variant system, and zero behavior change for any
client that never calls the four new tools.

## Rejected: capturing full evidence at finalize time instead of confirm time

Considered and rejected — see Decision 3. Would have let the browser
overlay stay lighter (just remembering a list of selectors), but
reintroduces selector-staleness risk and makes "browser optional after
finalize" a race rather than a guarantee.

## Rejected: one blocking MCP call for the whole interactive session

Considered and rejected — see Decision 5 and ADR 0013.

## Rejected: a WebSocket bridge between the overlay and Node

Considered and rejected — see Decision 4. `page.exposeFunction` covers
the actual requirement (event-style, browser-initiated communication)
without a second transport to secure or a new port to manage.
