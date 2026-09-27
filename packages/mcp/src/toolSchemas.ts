import { z } from "zod";

/**
 * Bounded, not unbounded — extracted from server.ts (which runs `main()`
 * at import time and so isn't importable from a test) specifically so
 * these limits have a regression test. See docs/adr/0013-generate-
 * design-ir-timeout.md's addendum: a real call set `maxToolIterations=15`
 * with `maxRepairAttempts=2`, worst-case ~48 sequential model calls in
 * one tool invocation — actively working against the timeout this ADR
 * fixes, not around it. The caps here (8 and 3) stay well above the
 * defaults (5 and 2) for legitimate cases while making that kind of
 * self-inflicted footgun a clear, immediate validation error instead of
 * a multi-minute hang.
 */
export const maxRepairAttemptsSchema = z
  .number()
  .int()
  .min(0)
  .max(3)
  .optional()
  .describe(
    "Bounded repair retries after an invalid IR (default 2, i.e. 3 total attempts). Each attempt re-runs the full model interpretation loop below, so this multiplies its cost — see maxToolIterations."
  );

export const maxToolIterationsSchema = z
  .number()
  .int()
  .min(1)
  .max(8)
  .optional()
  .describe(
    "Tool-calling iterations per interpretation attempt (default 5, capped at 8). Raising this does NOT improve capture thoroughness — the model already sees the full DOM tree, computed styles, and (when vision is enabled) a screenshot in its very first turn; more iterations only means more chances for it to ask for evidence it already has. It directly multiplies wall-clock time and is the single biggest lever on hitting an MCP client's request timeout (see docs/adr/0013-generate-design-ir-timeout.md) — the default of 5 is already generous. To capture multiple visual states (e.g. different card statuses), use `variants`, not a higher iteration budget."
  );
