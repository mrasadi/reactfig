/**
 * See ADR 0004 (repo root docs/adr) for why this interface has exactly
 * four methods and exactly two reference adapters. Nothing here is
 * provider-specific — @reactfig/analyzer's AI orchestration (Phase 4)
 * depends only on this file's exports, never on an adapter directly.
 */

export type ModelRole = "system" | "user" | "assistant" | "tool";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImageSource {
  kind: "path" | "base64" | "url";
  value: string;
  mediaType?: string; // e.g. "image/png" — required for kind "base64"
}

export interface ImagePart {
  type: "image";
  source: ImageSource;
}

export type ContentPart = TextPart | ImagePart;

/** A JSON Schema object. Intentionally not strongly typed here — providers pass it through to their own API; @reactfig/core owns the one schema (design-ir/v1) this project validates strictly. */
export type JsonSchema = Record<string, unknown>;

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: unknown; // parsed JSON, shaped per the tool's `parameters` schema
}

export interface Message {
  role: ModelRole;
  content: ContentPart[];
  /** Present on role:"tool" messages — which tool call this responds to. */
  toolCallId?: string;
  /** Present on role:"assistant" messages that requested tool calls. */
  toolCalls?: ToolCallRequest[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ModelCapabilities {
  structuredOutput: boolean;
  toolCalling: boolean;
  vision: boolean;
}

export interface GenerateInput {
  system?: string;
  messages: Message[];
  maxTokens?: number;
  /**
   * Optional external cancellation, e.g. the MCP client disconnected or
   * the tool call was cancelled — see docs/adr/0013-generate-design-ir-
   * timeout.md. Providers that make an HTTP call should combine this with
   * their own per-request timeout (`AbortSignal.any`) rather than
   * replacing it; not every provider necessarily honors this (the mock
   * provider doesn't need to), but `OpenAICompatibleProvider` and
   * `AnthropicProvider` both do.
   */
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
}

export interface GenerateWithToolsInput extends GenerateInput {
  tools: ToolDefinition[];
}

export interface GenerateWithToolsResult {
  /** Present when the model produced a final answer instead of / alongside tool calls. */
  text: string | null;
  /** Empty when the model is done reasoning and produced a final answer. */
  toolCalls: ToolCallRequest[];
}

export interface GenerateStructuredInput<T> extends GenerateInput {
  schemaName: string;
  schema: JsonSchema;
  /** Present only for type inference at call sites — never read at runtime. */
  __resultType?: T;
}

export interface GenerateStructuredResult<T> {
  value: T;
  /** The provider's raw (pre-validation) response, kept for debugging. */
  raw: unknown;
}

export interface AnalyzeImageInput {
  image: ImageSource;
  prompt: string;
}

/**
 * The one interface every AI-orchestration call site depends on.
 * `capabilities` must be accurate for the configured model — the
 * orchestration layer (packages/analyzer/src/ai) branches on it rather
 * than assuming every provider/model supports every method meaningfully.
 * `analyzeImage`/vision-carrying `generate*` calls on a
 * `capabilities.vision === false` provider should not be called by
 * orchestration code; providers are not required to guard against it
 * themselves (see providers/mock.ts for the one place tests do assert this).
 */
export interface ModelProvider {
  readonly name: string;
  readonly capabilities: ModelCapabilities;
  generate(input: GenerateInput): Promise<GenerateResult>;
  generateStructured<T>(input: GenerateStructuredInput<T>): Promise<GenerateStructuredResult<T>>;
  generateWithTools(input: GenerateWithToolsInput): Promise<GenerateWithToolsResult>;
  analyzeImage(input: AnalyzeImageInput): Promise<GenerateResult>;
}
