import type { ModelProvider } from "@reactfig/model";
import { validateDesignIR, type DesignDocument, type ValidationResult } from "@reactfig/core";
import type { ComponentEvidence } from "../evidence/types.js";
import { interpretComponent, type InterpretOptions } from "./interpret.js";
import { buildDesignIR } from "./buildDesignIR.js";
import type { ComponentInterpretation } from "./types.js";
import { debugLog } from "@reactfig/model";
import type { ProgressReporter } from "./progress.js";

export interface OrchestrateOptions {
  /** Bounded repair retries after an initial invalid IR — not an unbounded agent loop. Default 2. */
  maxRepairAttempts?: number;
  maxToolIterations?: InterpretOptions["maxToolIterations"];
  /** Optional free-text guidance forwarded to interpretComponent — see interpret.ts. */
  guidance?: string;
  /** Forwarded to the model provider on every call — see docs/adr/0013. */
  signal?: AbortSignal;
  /** Best-effort MCP progress notifications — see progress.ts. */
  onProgress?: ProgressReporter;
}

export interface OrchestrateResult {
  document: DesignDocument;
  interpretation: ComponentInterpretation;
  validation: ValidationResult;
  /** 1 = succeeded on the first pass, >1 = repair rounds were used. */
  attempts: number;
  toolCallCount: number;
}

/**
 * The full pipeline: ComponentEvidence → AI interpretation (interpret.ts,
 * the only model-facing stage) → deterministic IR construction
 * (buildDesignIR.ts, never calls a model) → @reactfig/core schema
 * validation → bounded repair if invalid. Never touches the Figma renderer
 * — that's out of scope for Phase 4 (docs/adr/0008).
 *
 * Throws only for a genuine capability mismatch (no structuredOutput) —
 * everything else either succeeds or exhausts the repair budget and
 * returns the last attempt with `validation.valid === false` so the
 * caller can inspect exactly what's wrong rather than getting an opaque
 * error.
 */
export async function generateDesignIR(
  provider: ModelProvider,
  evidence: ComponentEvidence,
  options: OrchestrateOptions = {}
): Promise<OrchestrateResult> {
  if (!provider.capabilities.structuredOutput) {
    throw new Error(
      `generateDesignIR requires a ModelProvider with structuredOutput capability; "${provider.name}" does not have it.`
    );
  }

  const maxAttempts = (options.maxRepairAttempts ?? 2) + 1;
  let repairContext: string | undefined;
  let toolCallCount = 0;

  let interpretation: ComponentInterpretation;
  let document: DesignDocument;
  let validation: ValidationResult;
  let attempt = 0;

  do {
    attempt++;
    debugLog("interpretation attempt started", { attempt, maxAttempts });
    options.onProgress?.(`interpretation attempt ${attempt}/${maxAttempts}`);
    const interpretResult = await interpretComponent(provider, evidence, {
      maxToolIterations: options.maxToolIterations,
      repairContext,
      guidance: options.guidance,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    toolCallCount += interpretResult.toolCallCount;
    interpretation = interpretResult.interpretation;

    debugLog("IR construction started", { attempt });
    document = buildDesignIR(evidence, interpretation);
    debugLog("IR construction finished", { attempt });

    debugLog("IR validation started", { attempt });
    validation = validateDesignIR(document);
    debugLog("IR validation finished", { attempt, valid: validation.valid, errorCount: validation.errors.length });

    if (!validation.valid) {
      repairContext = [
        "Your previous interpretation produced an invalid Design IR document once deterministically constructed.",
        `Validation errors: ${JSON.stringify(validation.errors)}`,
        "Common causes: an empty semanticName (names must be non-empty), or a path that doesn't exist in the DOM tree you were shown.",
        "Adjust your interpretation to fix these specific errors and try again.",
      ].join(" ");
    }
  } while (!validation.valid && attempt < maxAttempts);

  return { document, interpretation, validation, attempts: attempt, toolCallCount };
}
