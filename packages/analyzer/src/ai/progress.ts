/**
 * A minimal, transport-agnostic progress sink. `@reactfig/analyzer` has no
 * MCP dependency (see docs/adr/0010) and never will — this interface lets
 * `@reactfig/mcp` supply a callback that forwards to a real MCP
 * `notifications/progress` message without `@reactfig/analyzer` knowing
 * anything about MCP. See docs/adr/0013-generate-design-ir-timeout.md for
 * why this exists: it's the mechanism a long-running `generate_design_ir`
 * call uses to keep an MCP client's request-timeout clock from expiring
 * mid-call, for clients that support `resetTimeoutOnProgress`.
 *
 * Reporting progress is best-effort and orthogonal to `debugLog` (this
 * package's own stderr diagnostics, always available via `REACTFIG_DEBUG`)
 * — a caller with no MCP client (e.g. a unit test, or a future CLI) simply
 * never supplies one.
 */
export type ProgressReporter = (stage: string) => void;
