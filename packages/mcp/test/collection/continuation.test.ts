import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollectionSession } from "../../src/collection/collectionSession.js";
import { writeContinuationSignal, readContinuationSignal, ContinuationBridge } from "../../src/collection/continuation.js";
import { getInteractiveCaptureStatusTool } from "../../src/tools/getInteractiveCaptureStatus.js";
import { emulateContinuationKeystroke } from "../../src/collection/continuationKeystrokeAdapter.js";
import type { RawDomSnapshot } from "@reactfig/analyzer";

let projectRoot: string;
afterEach(() => {
  if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
});

function fakeRawSnapshot(): RawDomSnapshot {
  return {
    tag: "div",
    attributes: {},
    textContent: null,
    rect: { x: 0, y: 0, width: 100, height: 50 },
    computedStyle: {},
    naturalWidth: null,
    naturalHeight: null,
    componentPath: ["Card"],
    children: [],
  };
}

describe("Agent Continuation — persisted signal (continuation.ts)", () => {
  it("is absent for a fresh collection", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "reactfig-continuation-"));
    const session = await CollectionSession.create({ projectRoot, entryUrl: "http://localhost:3000" });
    expect(await readContinuationSignal(session.dir)).toBeNull();
  });

  it("writeContinuationSignal persists a durable, re-readable marker", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "reactfig-continuation-"));
    const session = await CollectionSession.create({ projectRoot, entryUrl: "http://localhost:3000" });

    const written = await writeContinuationSignal(session.dir);
    expect(written.source).toBe("browser-done-button");

    const readBack = await readContinuationSignal(session.dir);
    expect(readBack).toEqual(written);
  });

  it("survives being read by a completely separate CollectionSession.resume() (not just in-memory)", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "reactfig-continuation-"));
    const created = await CollectionSession.create({ projectRoot, entryUrl: "http://localhost:3000" });
    await writeContinuationSignal(created.dir);

    const resumed = await CollectionSession.resume({ projectRoot, collectionId: created.collectionId });
    const signal = await readContinuationSignal(resumed.dir);
    expect(signal).not.toBeNull();
  });
});

describe("Agent Continuation — in-process push (ContinuationBridge)", () => {
  it("fires a registered listener exactly once when signaled", () => {
    const bridge = new ContinuationBridge();
    let calls = 0;
    bridge.onceSignaled("col_abc", () => {
      calls++;
    });
    bridge.signal("col_abc");
    bridge.signal("col_abc"); // once() — a second signal without a new listener does nothing
    expect(calls).toBe(1);
  });

  it("does not cross-fire between different collectionIds", () => {
    const bridge = new ContinuationBridge();
    let calledForA = false;
    let calledForB = false;
    bridge.onceSignaled("col_a", () => (calledForA = true));
    bridge.onceSignaled("col_b", () => (calledForB = true));
    bridge.signal("col_a");
    expect(calledForA).toBe(true);
    expect(calledForB).toBe(false);
  });

  it("onceSignaled's returned unsubscribe function prevents the listener from firing", () => {
    const bridge = new ContinuationBridge();
    let calls = 0;
    const unsubscribe = bridge.onceSignaled("col_x", () => calls++);
    unsubscribe();
    bridge.signal("col_x");
    expect(calls).toBe(0);
  });
});

describe("Agent Continuation — get_interactive_capture_status surfaces it", () => {
  it("reports continuationPending: false before any Done/Continue click", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "reactfig-continuation-"));
    const session = await CollectionSession.create({ projectRoot, entryUrl: "http://localhost:3000" });
    await session.captureSelection({
      url: "http://localhost:3000",
      pageTitle: "Home",
      componentPath: ["Card"],
      selector: "#c1",
      tag: "div",
      rect: { x: 0, y: 0, width: 100, height: 50 },
      rawSnapshot: fakeRawSnapshot(),
      screenshot: Buffer.from("png"),
    });

    const status = await getInteractiveCaptureStatusTool({ collectionId: session.collectionId }, { projectRoot });
    expect(status.continuationPending).toBe(false);
    expect(status.continuationSignaledAt).toBeUndefined();
  });

  it("reports continuationPending: true with a timestamp once the marker is written — simulating the overlay's Done/Continue click", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "reactfig-continuation-"));
    const session = await CollectionSession.create({ projectRoot, entryUrl: "http://localhost:3000" });
    await session.captureSelection({
      url: "http://localhost:3000",
      pageTitle: "Home",
      componentPath: ["Card"],
      selector: "#c1",
      tag: "div",
      rect: { x: 0, y: 0, width: 100, height: 50 },
      rawSnapshot: fakeRawSnapshot(),
      screenshot: Buffer.from("png"),
    });

    // Same two steps __reactfigMarkDone performs, in the same order:
    // finalize, then persist the signal (docs section 20: finalized/
    // persisted before the browser closes).
    await session.finalize();
    const written = await writeContinuationSignal(session.dir);

    const status = await getInteractiveCaptureStatusTool({ collectionId: session.collectionId }, { projectRoot });
    expect(status.continuationPending).toBe(true);
    expect(status.continuationSignaledAt).toBe(written.signaledAt);
    expect(status.manifest.status).toBe("completed");
  });
});

describe("Agent Continuation — keystroke fallback adapter (docs section 19, opt-in only)", () => {
  it("throws when no `send` implementation is supplied — never a silent no-op default", async () => {
    // @ts-expect-error deliberately omitting the required option
    await expect(emulateContinuationKeystroke({})).rejects.toThrow(/no `send` implementation/);
  });

  it("invokes the caller-supplied `send` when given one", async () => {
    let called = false;
    await emulateContinuationKeystroke({ send: () => { called = true; } });
    expect(called).toBe(true);
  });
});
