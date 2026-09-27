import { describe, it, expect } from "vitest";
import { createPlaywrightCapture } from "../src/playwrightCapture.js";

/**
 * createPlaywrightCapture launches a real browser lazily (on first actual
 * capture call), so this only verifies the factory accepts
 * `storageStatePath` and returns a callable without throwing — genuine
 * behavioral verification (does the resulting context actually carry the
 * authenticated session) requires a real browser, which this sandbox
 * cannot run (see docs/e2e/phase7-report.md). Same disclosed-limitation
 * category as the rest of this file.
 */
describe("createPlaywrightCapture — storageState option (structural only)", () => {
  it("accepts an empty options object", () => {
    expect(() => createPlaywrightCapture()).not.toThrow();
    expect(() => createPlaywrightCapture({})).not.toThrow();
  });

  it("accepts a storageStatePath without throwing at construction time (browser launch is lazy)", () => {
    expect(() => createPlaywrightCapture({ storageStatePath: ".reactfig/auth.json" })).not.toThrow();
  });

  it("returns a function", () => {
    const capture = createPlaywrightCapture({ storageStatePath: ".reactfig/auth.json" });
    expect(typeof capture).toBe("function");
  });
});

/**
 * Unlike the rest of this file, this one genuinely doesn't need a real
 * browser — an already-aborted `request.signal` is checked and rejected
 * before any Playwright call is made, so it's real, verified behavior,
 * not a structural-only smoke test. See docs/adr/0013-generate-design-ir-
 * timeout.md.
 */
describe("createPlaywrightCapture — best-effort cancellation", () => {
  it("rejects immediately, before touching Playwright, when request.signal is already aborted", async () => {
    const capture = createPlaywrightCapture();
    const controller = new AbortController();
    controller.abort();

    await expect(
      capture({
        url: "http://localhost:1/should-never-be-navigated-to",
        selector: ".never",
        label: "default",
        viewport: { width: 100, height: 100 },
        rootComponentName: "Never",
        captureScreenshot: false,
        signal: controller.signal,
      })
    ).rejects.toThrow(/cancelled before it started/);
  });
});
/**
 * `applyInteractionState`'s own control flow (which Playwright calls it
 * makes, in what order, and what its returned cleanup function does) is
 * genuinely verifiable without a real browser — a fake Page/Locator that
 * just records calls proves the LOGIC is correct; it does NOT prove the
 * resulting `:hover`/`:focus`/`:active` CSS actually applies as expected
 * in a real browser, or that the 150ms settle wait in the caller
 * (createPlaywrightCapture) is enough for a real component's transitions
 * — see applyInteractionState's own doc comment and docs/adr/0023-
 * interaction-state-capture.md for that explicit, unverified boundary.
 */
describe("applyInteractionState — call shape (fake Page/Locator, not a real browser)", () => {
  function makeFakePage() {
    const calls: string[] = [];
    const locator = {
      hover: async () => {
        calls.push("locator.hover");
      },
      focus: async () => {
        calls.push("locator.focus");
      },
    };
    const page = {
      locator: (selector: string) => {
        calls.push(`page.locator(${selector})`);
        return { first: () => locator };
      },
      mouse: {
        down: async () => {
          calls.push("mouse.down");
        },
        up: async () => {
          calls.push("mouse.up");
        },
      },
      evaluate: async () => {
        calls.push("page.evaluate");
      },
    };
    return { page, calls };
  }

  it("returns a no-op cleanup and calls nothing when state is undefined", async () => {
    const { page, calls } = makeFakePage();
    const { applyInteractionState } = await import("../src/playwrightCapture.js");
    const release = await applyInteractionState(page as never, ".btn", undefined);
    await release();
    expect(calls).toEqual([]);
  });

  it("hover: calls locator.hover() once, and cleanup does nothing further", async () => {
    const { page, calls } = makeFakePage();
    const { applyInteractionState } = await import("../src/playwrightCapture.js");
    const release = await applyInteractionState(page as never, ".btn", "hover");
    expect(calls).toEqual(["page.locator(.btn)", "locator.hover"]);
    await release();
    expect(calls).toEqual(["page.locator(.btn)", "locator.hover"]); // cleanup added nothing
  });

  it("focus: calls locator.focus(), and cleanup blurs via page.evaluate", async () => {
    const { page, calls } = makeFakePage();
    const { applyInteractionState } = await import("../src/playwrightCapture.js");
    const release = await applyInteractionState(page as never, ".btn", "focus");
    expect(calls).toEqual(["page.locator(.btn)", "locator.focus"]);
    await release();
    expect(calls).toEqual(["page.locator(.btn)", "locator.focus", "page.evaluate"]);
  });

  it("active: hovers first, then presses the mouse down (no dedicated Playwright method); cleanup releases the mouse button", async () => {
    const { page, calls } = makeFakePage();
    const { applyInteractionState } = await import("../src/playwrightCapture.js");
    const release = await applyInteractionState(page as never, ".btn", "active");
    expect(calls).toEqual(["page.locator(.btn)", "locator.hover", "mouse.down"]);
    await release();
    expect(calls).toEqual(["page.locator(.btn)", "locator.hover", "mouse.down", "mouse.up"]);
  });
});
