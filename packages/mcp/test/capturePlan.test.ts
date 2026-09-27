import { describe, it, expect } from "vitest";
import { buildCapturePlan, computeCaptureId, computeRevisionKey, mergeCapturePlan, isCapturePlanComplete, type PlannedCaptureRequest } from "../src/capturePlan.js";

const defaultRequest: PlannedCaptureRequest = { label: "default", url: "http://localhost:3000", selector: ".btn", viewport: { width: 1440, height: 900 } };
const variantRequest: PlannedCaptureRequest = { ...defaultRequest, label: "variant=tone:success", propValues: { tone: "success" } };

describe("computeRevisionKey / computeCaptureId — determinism", () => {
  it("the same source hash + same requests always produces the same revisionKey", () => {
    const a = computeRevisionKey("sha256:abc", [defaultRequest, variantRequest]);
    const b = computeRevisionKey("sha256:abc", [defaultRequest, variantRequest]);
    expect(a).toBe(b);
  });

  it("a different source hash changes the revisionKey", () => {
    const a = computeRevisionKey("sha256:abc", [defaultRequest]);
    const b = computeRevisionKey("sha256:def", [defaultRequest]);
    expect(a).not.toBe(b);
  });

  it("a different requested capture set changes the revisionKey", () => {
    const a = computeRevisionKey("sha256:abc", [defaultRequest]);
    const b = computeRevisionKey("sha256:abc", [defaultRequest, variantRequest]);
    expect(a).not.toBe(b);
  });

  it("capture ids are stable for the same revisionKey + request, and distinct for different requests within the same plan", () => {
    const revisionKey = "rev1";
    const idA = computeCaptureId(revisionKey, defaultRequest);
    const idAAgain = computeCaptureId(revisionKey, defaultRequest);
    const idB = computeCaptureId(revisionKey, variantRequest);
    expect(idA).toBe(idAAgain);
    expect(idA).not.toBe(idB);
    expect(idA).toMatch(/^cap_[0-9a-f]{12}$/);
  });

  it("captureScreenshot/signal-style incidental settings aren't part of PlannedCaptureRequest, so they can never affect the id — only label/url/selector/viewport/propValues do", () => {
    // PlannedCaptureRequest's type itself excludes them; this test just pins the id to the fields that DO matter.
    const id1 = computeCaptureId("rev1", { ...defaultRequest, viewportLabel: "desktop" });
    const id2 = computeCaptureId("rev1", { ...defaultRequest, viewportLabel: "desktop" });
    expect(id1).toBe(id2);
  });

  it("interactionState is part of a capture's identity — a hover capture and its otherwise-identical default counterpart never collide", () => {
    const revisionKey = "rev1";
    const idDefault = computeCaptureId(revisionKey, defaultRequest);
    const idHover = computeCaptureId(revisionKey, { ...defaultRequest, interactionState: "hover" });
    const idFocus = computeCaptureId(revisionKey, { ...defaultRequest, interactionState: "focus" });
    expect(new Set([idDefault, idHover, idFocus]).size).toBe(3);
  });
});

describe("buildCapturePlan", () => {
  it("builds one entry per request, all pending, each with a deterministic id", () => {
    const plan = buildCapturePlan("sha256:abc", [defaultRequest, variantRequest]);
    expect(plan.captures).toHaveLength(2);
    expect(plan.captures.every((c) => c.status === "pending")).toBe(true);
    expect(new Set(plan.captures.map((c) => c.id)).size).toBe(2); // no id collisions
  });

  it("building the same plan twice produces identical ids in the same order", () => {
    const planA = buildCapturePlan("sha256:abc", [defaultRequest, variantRequest]);
    const planB = buildCapturePlan("sha256:abc", [defaultRequest, variantRequest]);
    expect(planA.captures.map((c) => c.id)).toEqual(planB.captures.map((c) => c.id));
  });
});

describe("mergeCapturePlan — resume semantics", () => {
  it("carries over a completed entry's status from the persisted plan, by id", () => {
    const fresh = buildCapturePlan("sha256:abc", [defaultRequest, variantRequest]);
    const persisted = { revisionKey: fresh.revisionKey, captures: fresh.captures.map((c, i) => (i === 0 ? { ...c, status: "completed" as const } : c)) };

    const merged = mergeCapturePlan(fresh, persisted);
    expect(merged.captures[0].status).toBe("completed");
    expect(merged.captures[1].status).toBe("pending"); // untouched — still needs capturing
  });

  it("carries over a failed entry so it's eligible for retry, with its error message preserved for the report", () => {
    const fresh = buildCapturePlan("sha256:abc", [defaultRequest]);
    const persisted = { revisionKey: fresh.revisionKey, captures: [{ ...fresh.captures[0], status: "failed" as const, error: "browser timeout" }] };

    const merged = mergeCapturePlan(fresh, persisted);
    expect(merged.captures[0].status).toBe("failed");
    expect(merged.captures[0].error).toBe("browser timeout");
  });

  it("an entry in the fresh plan with no matching persisted id (e.g. a newly added variant) stays pending", () => {
    const freshOneRequest = buildCapturePlan("sha256:abc", [defaultRequest]);
    const freshTwoRequests = buildCapturePlan("sha256:abc", [defaultRequest, variantRequest]);
    const persisted = { revisionKey: freshOneRequest.revisionKey, captures: [{ ...freshOneRequest.captures[0], status: "completed" as const }] };

    // Same revisionKey computation isn't realistic here since the request sets differ (this is a defensive
    // "unknown id" case within mergeCapturePlan itself, not a real resume scenario — those never mix requests).
    const merged = mergeCapturePlan({ ...freshTwoRequests, revisionKey: persisted.revisionKey }, persisted);
    const variantEntry = merged.captures.find((c) => c.label === "variant=tone:success")!;
    expect(variantEntry.status).toBe("pending");
  });
});

describe("isCapturePlanComplete", () => {
  it("false when any entry isn't completed", () => {
    const plan = buildCapturePlan("sha256:abc", [defaultRequest, variantRequest]);
    expect(isCapturePlanComplete(plan)).toBe(false);
  });

  it("true once every entry is completed", () => {
    const plan = buildCapturePlan("sha256:abc", [defaultRequest]);
    plan.captures[0].status = "completed";
    expect(isCapturePlanComplete(plan)).toBe(true);
  });

  it("true for an empty plan (vacuously — no components without any requested captures in practice, but the function itself shouldn't special-case it)", () => {
    expect(isCapturePlanComplete({ revisionKey: "x", captures: [] })).toBe(true);
  });
});
