import { describe, it, expect } from "vitest";
import { createPlaywrightFindSelector } from "../src/playwrightFindSelector.js";

/**
 * Same disclosed limitation as playwrightcapture.test.ts: a real browser
 * launch (on first actual call) can't be exercised in this sandbox (see
 * docs/e2e/phase7-report.md) — this only verifies the factory's
 * structural contract.
 */
describe("createPlaywrightFindSelector (structural only)", () => {
  it("accepts an empty options object", () => {
    expect(() => createPlaywrightFindSelector()).not.toThrow();
    expect(() => createPlaywrightFindSelector({})).not.toThrow();
  });

  it("accepts a storageStatePath without throwing at construction time (browser launch is lazy)", () => {
    expect(() => createPlaywrightFindSelector({ storageStatePath: ".reactfig/auth.json" })).not.toThrow();
  });

  it("returns a function", () => {
    const findInstances = createPlaywrightFindSelector();
    expect(typeof findInstances).toBe("function");
  });
});
