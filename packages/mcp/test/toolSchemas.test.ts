import { describe, expect, it } from "vitest";
import { maxRepairAttemptsSchema, maxToolIterationsSchema } from "../src/toolSchemas.js";
import { MAX_TOOL_ITERATIONS } from "@reactfig/analyzer";

describe("tool-call budget bounds — docs/adr/0013-generate-design-ir-timeout.md addendum", () => {
  // Motivated directly by a real call: maxToolIterations=15,
  // maxRepairAttempts=2 → worst case 3 * (15 + 1) = 48 sequential model
  // calls in one tool invocation, actively working against the timeout
  // fix rather than helping. These bounds turn that into an immediate,
  // clear validation error instead of a multi-minute hang.

  it("accepts the documented defaults' neighborhood and rejects the value that caused a real-world worst case", () => {
    expect(maxToolIterationsSchema.safeParse(5).success).toBe(true); // default
    expect(maxToolIterationsSchema.safeParse(8).success).toBe(true); // cap
    expect(maxToolIterationsSchema.safeParse(15).success).toBe(false); // the actual reported value
    expect(maxToolIterationsSchema.safeParse(9).success).toBe(false);
    expect(maxToolIterationsSchema.safeParse(0).success).toBe(false);
  });

  it("maxRepairAttempts stays within [0, 3]", () => {
    expect(maxRepairAttemptsSchema.safeParse(2).success).toBe(true); // default
    expect(maxRepairAttemptsSchema.safeParse(0).success).toBe(true);
    expect(maxRepairAttemptsSchema.safeParse(3).success).toBe(true);
    expect(maxRepairAttemptsSchema.safeParse(4).success).toBe(false);
    expect(maxRepairAttemptsSchema.safeParse(-1).success).toBe(false);
  });

  it("both are optional (undefined falls through to the analyzer's own defaults)", () => {
    expect(maxToolIterationsSchema.safeParse(undefined).success).toBe(true);
    expect(maxRepairAttemptsSchema.safeParse(undefined).success).toBe(true);
  });

  it("the analyzer's own default actually IS 5 — this schema's description promises that, but nothing previously checked the two stayed in sync (docs/adr/0028: it had silently drifted to 2, starving every real interpretation of most of its intended tool-call budget)", () => {
    expect(MAX_TOOL_ITERATIONS).toBe(5);
    // And it must itself fall inside the bounds this schema enforces —
    // a "default" outside its own valid range would be a second way for
    // these two to disagree.
    expect(maxToolIterationsSchema.safeParse(MAX_TOOL_ITERATIONS).success).toBe(true);
  });
});
