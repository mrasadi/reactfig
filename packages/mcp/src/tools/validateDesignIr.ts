import { validateDesignIR, type ValidationResult } from "@reactfig/core";

export interface ValidateDesignIrArgs {
  document: unknown;
}

/**
 * Deterministic validation is already internal to the normal pipeline —
 * generate_design_ir never returns an unvalidated document, and
 * export_design_artifact validates again before packaging (pack() itself
 * validates too). This tool exists purely for debugging/inspection: a
 * client can check a document it constructed or edited by hand without
 * going through the rest of the pipeline.
 */
export async function validateDesignIrTool(args: ValidateDesignIrArgs): Promise<ValidationResult> {
  return validateDesignIR(args.document);
}
