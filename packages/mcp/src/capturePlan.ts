/**
 * A capture plan is the smallest abstraction needed to make
 * generate_design_ir's existing multi-capture loop (one default viewport +
 * any extra viewports + any variants — see generateDesignIr.ts) resumable:
 * a deterministic, ordered list of what's being captured, each entry's
 * completion status, and a stable id per entry so two calls asking for the
 * *same* captures against the *same* source state always agree on which
 * ones are already done.
 *
 * This deliberately reuses checkpoint.ts's existing versioned-directory
 * machinery rather than introducing a second persistence mechanism: a
 * capture plan is just one more checkpoint file (capture-plan.json) inside
 * the same version directory as evidence.json/design-ir.json/etc., and
 * each individual completed capture's raw RenderCapture is stored as its
 * own small file under that version directory's captures/ subfolder (see
 * checkpoint.ts's writeCaptureArtifact/readCaptureArtifact) — reusing the
 * exact same atomic write-then-rename pattern writeCheckpoint already
 * uses, not a new one.
 */

import { createHash } from "node:crypto";
import { stableStringify } from "@reactfig/core";

/** The identity of one requested capture — deliberately excludes incidental runtime settings (captureScreenshot, an AbortSignal) that don't change *what* is being captured, only how. */
export interface PlannedCaptureRequest {
  label: string;
  url: string;
  selector: string;
  viewport: { width: number; height: number };
  viewportLabel?: string;
  propValues?: Record<string, unknown>;
  /** See generateDesignIr.ts's VariantCaptureSpec/CaptureRequest — included in this identity so a hover capture and its default counterpart, otherwise identical, always get distinct capture ids (see computeCaptureId below). */
  interactionState?: "hover" | "focus" | "active";
}

export interface PlannedCapture extends PlannedCaptureRequest {
  /** Deterministic — see computeCaptureId. The same revisionKey + the same request always produces the same id, so a resumed run recognizes "this one's already done" instead of recapturing it. */
  id: string;
  status: "pending" | "completed" | "failed";
  /** Present only when status is "failed" — the error message from the last attempt, kept for the report even after a later successful retry overwrites it back to undefined. */
  error?: string;
}

export interface CapturePlan {
  /**
   * Ties this plan to one specific source state *and* one specific
   * requested capture set. A persisted plan only resumes against a freshly
   * built plan whose revisionKey matches exactly — if the source changed
   * (new contentHash) or the caller is asking for a different set of
   * viewports/variants this time, resuming would silently mix stale and
   * fresh captures, so a mismatch always falls back to starting a new
   * checkpoint version instead (see checkpoint.ts's
   * openOrResumeVersionedCheckpointDir).
   */
  revisionKey: string;
  captures: PlannedCapture[];
}

/** Deterministic per-capture id: `cap_<12 hex chars>`, derived from the revisionKey plus this specific request's own identity (label/url/selector/viewport/propValues) — so even two requests within the *same* plan never collide. */
export function computeCaptureId(revisionKey: string, request: PlannedCaptureRequest): string {
  const hash = createHash("sha256").update(revisionKey).update(stableStringify(request)).digest("hex");
  return `cap_${hash.slice(0, 12)}`;
}

/** Deterministic revision key: same source content hash + same ordered set of requests always produces the same key, regardless of when or how many times it's computed. */
export function computeRevisionKey(sourceContentHash: string, requests: PlannedCaptureRequest[]): string {
  const hash = createHash("sha256").update(sourceContentHash).update(stableStringify(requests)).digest("hex");
  return hash.slice(0, 16);
}

/** Builds a fresh plan with every entry "pending" — the starting point before any resume-merge against a persisted plan happens. */
export function buildCapturePlan(sourceContentHash: string, requests: PlannedCaptureRequest[]): CapturePlan {
  const revisionKey = computeRevisionKey(sourceContentHash, requests);
  return {
    revisionKey,
    captures: requests.map((request) => ({ ...request, id: computeCaptureId(revisionKey, request), status: "pending" as const })),
  };
}

/**
 * Merges a freshly-built plan (this call's requested captures, all
 * "pending") with a previously-persisted plan for the *same* revisionKey:
 * carries over each entry's persisted status by id, so anything already
 * "completed" stays completed and isn't recaptured, anything "failed"
 * becomes eligible for a retry, and the ordering/identity of the fresh
 * plan otherwise wins (in case the persisted plan is from an older,
 * slightly different checkpoint-layout version). Only ever call this when
 * the two plans' revisionKeys already match — see openOrResumeVersionedCheckpointDir.
 */
export function mergeCapturePlan(freshPlan: CapturePlan, persistedPlan: CapturePlan): CapturePlan {
  const persistedById = new Map(persistedPlan.captures.map((c) => [c.id, c]));
  return {
    revisionKey: freshPlan.revisionKey,
    captures: freshPlan.captures.map((c) => persistedById.get(c.id) ?? c),
  };
}

/** True once every entry in the plan is "completed" — the signal that the capture stage as a whole is done and evidence assembly can proceed. */
export function isCapturePlanComplete(plan: CapturePlan): boolean {
  return plan.captures.every((c) => c.status === "completed");
}
