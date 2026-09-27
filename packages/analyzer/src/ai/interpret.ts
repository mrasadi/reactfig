import type { GenerateWithToolsInput, Message, ModelProvider, ToolCallRequest } from "@reactfig/model";
import type { ComponentEvidence } from "../evidence/types.js";
import { EvidenceStore } from "./evidenceStore.js";
import { GET_EVIDENCE_TOOL, executeGetEvidenceTool } from "./tools.js";
import { buildInitialBundle } from "./evidenceBundle.js";
import { buildComponentInterpretationSchema } from "./schema.js";
import type { ComponentInterpretation } from "./types.js";
import { debugLog } from "@reactfig/model";
import type { ProgressReporter } from "./progress.js";

// This is the DEFAULT — overridable per-call via InterpretOptions.maxToolIterations
// (which generate_design_ir's own maxToolIterations argument threads
// through). Documented and capped at the MCP tool-schema level
// (packages/mcp/src/toolSchemas.ts's maxToolIterationsSchema, min 1 max
// 8) as "default 5" — this constant is the single source of truth for
// that default and MUST stay in sync with it (see docs/adr/0028's real-
// world finding: this constant had drifted to 2, silently starving every
// interpretation of 3 of its intended 5 tool-call turns before the model
// could even ask for most of the evidence it needed, well before hitting
// the schema's own upper bound of 8 — nothing validated the two stayed
// consistent).
export const MAX_TOOL_ITERATIONS = 5;

const SYSTEM_PROMPT = [
  "You interpret a React component's deterministic evidence (DOM structure, computed styles, bounding boxes, source props) into a compact semantic interpretation.",
  "Deterministic evidence is always correct — never contradict bounds, colors, spacing, or text that evidence already states. Your job is judgment evidence cannot supply: which prop combinations are genuine design variants, which wrapper elements are decorative and should collapse, and human-readable names.",
  "Only confirm a variant value if you have direct evidence for it (a capture whose propValues include it, or the DOM actually showing it). Do not invent a visual variant you have not seen evidence for.",
  "Request additional evidence via get_evidence when the initial bundle isn't enough — do not guess when you could look it up. When you have enough evidence, stop calling tools and you will be asked for your final structured interpretation.",
].join(" ");

export interface InterpretOptions {
  maxToolIterations?: number;
  /** Extra instructions appended to the system prompt for a repair pass — see orchestrate.ts. */
  repairContext?: string;
  /**
   * Optional free-text guidance from the caller (e.g. "focus on the
   * avatar's status-dot overlay and badge styling") — appended to the
   * system prompt exactly like `repairContext`. Added because a real MCP
   * client passed a `prompt` argument the tool schema didn't recognize;
   * previously the field was silently stripped by zod's default
   * unknown-key handling and had no effect at all. See docs/adr/0013's
   * addendum.
   */
  guidance?: string;
  /** Forwarded to the model provider on every call — see docs/adr/0013. */
  signal?: AbortSignal;
  /** Best-effort MCP progress notifications — see progress.ts. */
  onProgress?: ProgressReporter;
}

export interface InterpretResult {
  interpretation: ComponentInterpretation;
  /** How many get_evidence tool calls were actually made — for cost/latency visibility. */
  toolCallCount: number;
  /** True if MAX_TOOL_ITERATIONS was hit before the model signaled it was done. */
  hitIterationBudget: boolean;
}

/**
 * Runs the interpretation stage: an optional tool-calling loop (when the
 * provider supports it) over ComponentEvidence, then one generateStructured
 * call to produce the final ComponentInterpretation. This is the only
 * model-facing stage in the pipeline — IR construction (buildDesignIR.ts)
 * is deterministic and never calls a model. See docs/adr/0008 for why this
 * collapses the brief's six-stage sketch into one reasoning stage plus
 * deterministic construction.
 */
export async function interpretComponent(
  provider: ModelProvider,
  evidence: ComponentEvidence,
  options: InterpretOptions = {}
): Promise<InterpretResult> {
  const store = new EvidenceStore(evidence);
  const bundle = buildInitialBundle(evidence, store);
  const maxIterations = options.maxToolIterations ?? MAX_TOOL_ITERATIONS;
  const system = [SYSTEM_PROMPT, options.guidance, options.repairContext].filter(Boolean).join("\n\n");

  const initialContent: Message["content"] = [{ type: "text", text: bundle.text }];
  if (provider.capabilities.vision && bundle.primaryScreenshotPath) {
    initialContent.push({ type: "image", source: { kind: "path", value: bundle.primaryScreenshotPath } });
  }
  const messages: Message[] = [{ role: "user", content: initialContent }];

  let toolCallCount = 0;
  let hitIterationBudget = false;

  if (provider.capabilities.toolCalling) {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      debugLog("model call started", { kind: "generateWithTools", iteration });
      options.onProgress?.(`model tool-call iteration ${iteration + 1}/${maxIterations}`);
      const toolsInput: GenerateWithToolsInput = { system, messages, tools: [GET_EVIDENCE_TOOL], signal: options.signal };
      const response = await provider.generateWithTools(toolsInput);
      debugLog("model call finished", { kind: "generateWithTools", iteration, toolCallCount: response.toolCalls.length });

      if (response.toolCalls.length === 0) {
        break; // model is done reasoning — proceed to finalize
      }

      messages.push({ role: "assistant", content: response.text ? [{ type: "text", text: response.text }] : [], toolCalls: response.toolCalls });

      for (const call of response.toolCalls) {
        toolCallCount++;
        const result = executeGetEvidenceTool(store, call.arguments);
        const toolContent: Message["content"] = [{ type: "text", text: result.text }];
        if (result.imagePath && provider.capabilities.vision) {
          toolContent.push({ type: "image", source: { kind: "path", value: result.imagePath } });
        }
        messages.push({ role: "tool", toolCallId: call.id, content: toolContent });
      }

      if (iteration === maxIterations - 1) {
        hitIterationBudget = true;
      }
    }
  }

  const schema = buildComponentInterpretationSchema(evidence);
  debugLog("model call started", { kind: "generateStructured" });
  options.onProgress?.("model final structured-output call");
  const structured = await provider.generateStructured<ComponentInterpretation>({
    system,
    messages: [...messages, { role: "user", content: [{ type: "text", text: "Provide your final ComponentInterpretation now." }] }],
    schemaName: "ComponentInterpretation",
    schema,
    signal: options.signal,
  });
  debugLog("model call finished", { kind: "generateStructured" });

  const interpretation = enforceVariantEvidence(structured.value, evidence);
  if (hitIterationBudget) {
    interpretation.notes = [interpretation.notes, `(tool-call budget of ${maxIterations} reached before the model signaled completion)`]
      .filter(Boolean)
      .join(" ");
  }

  return { interpretation, toolCallCount, hitIterationBudget };
}

/**
 * Hard runtime enforcement of the anti-hallucination rule, independent of
 * whether the provider's JSON-Schema support actually honors `enum`
 * constraints (support varies): drops any variantAxes entry whose propName
 * isn't a real variant-capable prop in evidence, and any confirmedValues
 * entry not present in that prop's literalValues. This never *adds*
 * anything the model didn't say — it only removes what evidence doesn't
 * back up.
 */
function enforceVariantEvidence(interpretation: ComponentInterpretation, evidence: ComponentEvidence): ComponentInterpretation {
  const propsByName = new Map(evidence.source.props.map((p) => [p.name, p]));
  const filtered = interpretation.variantAxes
    .map((axis) => {
      const prop = propsByName.get(axis.propName);
      const allowed = new Set(prop?.literalValues ?? []);
      const confirmedValues = axis.confirmedValues.filter((v) => allowed.has(v));
      return { ...axis, confirmedValues };
    })
    .filter((axis) => axis.confirmedValues.length > 0);

  return { ...interpretation, variantAxes: filtered };
}
