import Ajv from "ajv";
import type { JsonSchema } from "./types.js";

/**
 * `generateStructured()` must never hand back Markdown/prose as if it
 * were the requested structured JSON — see docs/adr/0014-structured-
 * output-and-ir-construction.md. This module is the one place that
 * decides whether a model's raw response text is actually usable JSON,
 * and whether that JSON actually matches the schema the caller asked
 * for. Neither provider adapter is allowed to skip this and return
 * unvalidated data.
 */

/**
 * Attempts, in order, to recover a JSON value from raw model output:
 * 1. The whole string parses as JSON directly (the well-behaved case —
 *    `response_format: json_schema` honored).
 * 2. A fenced code block (```json ... ``` or ``` ... ```) contains JSON —
 *    the single most common way an instruction-tuned model "helpfully"
 *    wraps JSON in prose despite being asked for raw structured output.
 * 3. A balanced `{...}` span exists anywhere in the text (the model added
 *    a sentence before/after the object but the object itself is intact).
 *
 * Returns `undefined` if none of these produce syntactically valid JSON —
 * callers must not fall back further than this (e.g. must not attempt to
 * parse arbitrary Markdown structure as if it were the schema).
 */
export function extractJsonCandidate(text: string): unknown {
  const direct = tryParse(text.trim());
  if (direct !== undefined) return direct;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const fromFence = tryParse(fenced[1].trim());
    if (fromFence !== undefined) return fromFence;
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const fromBraceScan = tryParse(text.slice(firstBrace, lastBrace + 1));
    if (fromBraceScan !== undefined) return fromBraceScan;
  }

  return undefined;
}

function tryParse(candidate: string): unknown {
  if (!candidate) return undefined;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

// `strict: false` — schemas passed in here (both @reactfig/analyzer's own
// ComponentInterpretation schema and, for AnthropicProvider, a copy of the
// same JSON Schema reused as a tool `input_schema`) are plain JSON Schema
// objects from call sites outside this package's control; the point of
// this validator is catching *data* that doesn't match the *schema*, not
// linting the schema's own strict-mode compliance.
const ajv = new Ajv({ allErrors: true, strict: false });

export interface StructuredValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateStructuredOutput(value: unknown, schema: JsonSchema): StructuredValidationResult {
  const validateFn = ajv.compile(schema);
  const valid = validateFn(value);
  if (valid) return { valid: true, errors: [] };
  const errors = (validateFn.errors ?? []).map((e: { instancePath: string; message?: string }) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`);
  return { valid: false, errors };
}
