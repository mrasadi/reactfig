export * from "./types.js";
export { MockModelProvider, type MockScript } from "./providers/mock.js";
export { OpenAICompatibleProvider, type OpenAICompatibleOptions } from "./providers/openaiCompatible.js";
export { AnthropicProvider, type AnthropicOptions } from "./providers/anthropic.js";
export { extractJsonCandidate, validateStructuredOutput, type StructuredValidationResult } from "./structuredOutput.js";

// Diagnostics (Phase 8) — see docs/adr/0013-generate-design-ir-timeout.md
export { debugLog, isDebugEnabled } from "./debugLog.js";
