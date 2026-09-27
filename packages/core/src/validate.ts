import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "./schema/design-ir.v1.schema.json" with { type: "json" };
import type { DesignDocument } from "./types.js";

export interface ValidationError {
  /** JSON pointer to the offending location, e.g. "/pages/0/children/2/bounds". */
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
const validateFn = ajv.compile(schema);

function toValidationErrors(errors: ErrorObject[] | null | undefined): ValidationError[] {
  if (!errors) return [];
  return errors.map((e) => ({
    path: e.instancePath || "/",
    message: e.message ?? "invalid",
  }));
}

/**
 * Validates an unknown value against design-ir/v1. Does not throw — callers
 * decide what to do with an invalid document (this is used both when the
 * MCP server assembles a document and, independently, when the Figma
 * plugin unpacks an artifact — the plugin should never trust an artifact
 * it didn't just generate itself).
 */
export function validateDesignIR(doc: unknown): ValidationResult {
  const valid = validateFn(doc);
  return { valid: !!valid, errors: toValidationErrors(validateFn.errors) };
}

/** Throws if invalid; convenience for call sites that want a hard failure. */
export function assertDesignIR(doc: unknown): asserts doc is DesignDocument {
  const result = validateDesignIR(doc);
  if (!result.valid) {
    const detail = result.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new Error(`Invalid design-ir/v1 document: ${detail}`);
  }
}
