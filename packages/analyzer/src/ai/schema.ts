import type { JsonSchema } from "@reactfig/model";
import type { ComponentEvidence } from "../evidence/types.js";

/**
 * Builds the ComponentInterpretation JSON Schema for one specific
 * ComponentEvidence document. The key anti-hallucination mechanism lives
 * here: `variantAxes[].propName` is an enum of exactly the prop names that
 * have `literalValues` in evidence, and — critically — the schema does not
 * merely describe the shape, the *orchestration layer* additionally
 * cross-checks `confirmedValues` against each prop's actual
 * `literalValues` after the model responds (schema `enum` support varies
 * by provider/JSON-Schema-subset, so this is enforced twice: once as a
 * schema hint, once as a hard runtime check in interpret.ts). A model
 * cannot make the pipeline accept a variant value evidence never showed.
 */
export function buildComponentInterpretationSchema(evidence: ComponentEvidence): JsonSchema {
  const variantProps = evidence.source.props.filter((p) => p.literalValues && p.literalValues.length > 0);
  const propNameEnum = variantProps.map((p) => p.name);

  return {
    type: "object",
    additionalProperties: false,
    required: ["componentDisplayName", "variantAxes", "nodeAnnotations"],
    properties: {
      componentDisplayName: { type: "string", minLength: 1 },
      variantAxes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["propName", "confirmedValues", "rationale"],
          properties: {
            propName: propNameEnum.length > 0 ? { type: "string", enum: propNameEnum } : { type: "string" },
            confirmedValues: { type: "array", items: { type: "string" }, minItems: 1 },
            rationale: { type: "string" },
          },
        },
      },
      nodeAnnotations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: {
            path: { type: "array", items: { type: "integer", minimum: 0 } },
            semanticType: { type: "string", enum: ["frame", "group", "text", "image", "shape", "skip"] },
            semanticName: { type: "string" },
            rationale: { type: "string" },
          },
        },
      },
      notes: { type: "string" },
    },
  };
}
