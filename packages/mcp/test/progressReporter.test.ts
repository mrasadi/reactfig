import { describe, expect, it, vi } from "vitest";
import { makeProgressReporter } from "../src/progressReporter.js";

describe("makeProgressReporter — docs/adr/0013-generate-design-ir-timeout.md", () => {
  it("returns undefined when the client did not send a progressToken", () => {
    const sendNotification = vi.fn();
    const reporter = makeProgressReporter(sendNotification, undefined);
    expect(reporter).toBeUndefined();
  });

  it("sends one notifications/progress message per stage, with a monotonically increasing counter", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const reporter = makeProgressReporter(sendNotification, "token-123");
    expect(reporter).toBeDefined();

    reporter!("browser launch started");
    reporter!("navigation started");
    // sendNotification is fired-and-forgotten (never awaited by the
    // reporter itself, so a slow/hanging client can't block the pipeline)
    // — flush microtasks once before asserting.
    await Promise.resolve();
    await Promise.resolve();

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(sendNotification).toHaveBeenNthCalledWith(1, {
      method: "notifications/progress",
      params: { progressToken: "token-123", progress: 1, message: "browser launch started" },
    });
    expect(sendNotification).toHaveBeenNthCalledWith(2, {
      method: "notifications/progress",
      params: { progressToken: "token-123", progress: 2, message: "navigation started" },
    });
  });

  it("never throws or propagates a rejection when sendNotification itself rejects (a vanished/disconnected client must not fail the tool call)", async () => {
    const sendNotification = vi.fn().mockRejectedValue(new Error("client gone"));
    const reporter = makeProgressReporter(sendNotification, 42);

    expect(() => reporter!("some stage")).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    // No unhandled rejection — vitest would fail the run if one escaped.
  });

  it("preserves a numeric progressToken as-is (tokens may be string or number per the MCP spec)", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const reporter = makeProgressReporter(sendNotification, 7);
    reporter!("stage");
    await Promise.resolve();
    expect(sendNotification).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: { progressToken: 7, progress: 1, message: "stage" },
    });
  });
});
