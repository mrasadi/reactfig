import { readFile } from "node:fs/promises";
import { debugLog } from "../debugLog.js";
import { validateStructuredOutput } from "../structuredOutput.js";
import type {
  AnalyzeImageInput,
  ContentPart,
  GenerateInput,
  GenerateResult,
  GenerateStructuredInput,
  GenerateStructuredResult,
  GenerateWithToolsInput,
  GenerateWithToolsResult,
  ImageSource,
  Message,
  ModelCapabilities,
  ModelProvider,
  ToolCallRequest,
} from "../types.js";

export interface AnthropicOptions {
  apiKey: string;
  model: string; // e.g. "claude-sonnet-5"
  baseUrl?: string; // defaults to https://api.anthropic.com
  capabilities?: Partial<ModelCapabilities>;
  fetchImpl?: typeof fetch;
  anthropicVersion?: string;
   /** Timeout for HTTP requests to the Anthropic API in milliseconds. Default 60000. */
  requestTimeout?: number;
}

interface AnthropicContentBlock {
  type: "text" | "tool_use" | "tool_result" | "image";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  source?: { type: "base64"; media_type: string; data: string };
}

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason: string;
}

const STRUCTURED_OUTPUT_TOOL_NAME = "__reactfig_structured_output";

/**
 * Targets the Anthropic Messages API. Anthropic has no separate
 * JSON-schema response-format parameter (unlike the OpenAI-compatible
 * shape), so `generateStructured` is implemented via the well-known
 * technique of defining one synthetic tool whose input schema *is* the
 * requested schema and forcing the model to call it
 * (`tool_choice: {type: "tool", name: ...}`) — the tool's `input` is then
 * the structured result. This is a real, if slightly unusual, mapping of
 * this project's provider-agnostic interface onto Anthropic's actual API
 * shape, not a hidden approximation.
 *
 * Like `OpenAICompatibleProvider`, this class is real and type-checked but
 * has not been exercised against a live endpoint in this sandboxed dev
 * environment (no ANTHROPIC_API_KEY configured here).
 */
export class AnthropicProvider implements ModelProvider {
  readonly name: string;
  readonly capabilities: ModelCapabilities;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly requestTimeout: number;

  constructor(private readonly options: AnthropicOptions) {
    this.name = `anthropic:${options.model}`;
    this.capabilities = {
      structuredOutput: true,
      toolCalling: true,
      vision: true,
        ...options.capabilities,
      };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://api.anthropic.com";
    this.requestTimeout = options.requestTimeout ?? 60000;
    }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const response = await this.post(
      {
        max_tokens: input.maxTokens ?? 4096,
        system: input.system,
        messages: await Promise.all(input.messages.map(toAnthropicMessage)),
      },
      input.signal
    );
    return { text: textFromBlocks(response.content) };
  }

  async generateWithTools(input: GenerateWithToolsInput): Promise<GenerateWithToolsResult> {
    if (!this.capabilities.toolCalling) {
      throw new Error(`${this.name}: toolCalling capability is disabled for this provider configuration`);
    }
    const response = await this.post(
      {
        max_tokens: input.maxTokens ?? 4096,
        system: input.system,
        messages: await Promise.all(input.messages.map(toAnthropicMessage)),
        tools: input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      },
      input.signal
    );
    const toolCalls: ToolCallRequest[] = response.content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id!, name: b.name!, arguments: b.input }));
    return { text: toolCalls.length > 0 ? null : textFromBlocks(response.content), toolCalls };
  }

  async generateStructured<T>(input: GenerateStructuredInput<T>): Promise<GenerateStructuredResult<T>> {
    if (!this.capabilities.structuredOutput) {
      throw new Error(`${this.name}: structuredOutput capability is disabled for this provider configuration`);
    }
    const baseMessages = await Promise.all(input.messages.map(toAnthropicMessage));
    const tools = [{ name: STRUCTURED_OUTPUT_TOOL_NAME, description: `Return the ${input.schemaName} result.`, input_schema: input.schema }];

    // Forcing tool_choice makes Anthropic far less likely than a generic
    // OpenAI-compatible endpoint to return prose instead of structured
    // data (see OpenAICompatibleProvider.generateStructured and docs/
    // adr/0014) — but the tool's `input` is still model-generated content,
    // not something the API itself guarantees matches every constraint in
    // an arbitrary JSON Schema (enums, custom `required` combinations,
    // etc.). Validating before returning, with the same one-bounded-retry
    // pattern, is defense in depth rather than an assumption that forced
    // tool use is infallible.
    let lastFailureReason = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const messages =
        attempt === 0
          ? baseMessages
          : [
              ...baseMessages,
              {
                role: "user" as const,
                content: `Your previous "${input.schemaName}" tool call did not match the required schema (${lastFailureReason}). Call the tool again with corrected arguments that satisfy the schema exactly.`,
              },
            ];
      const response = await this.post(
        {
          max_tokens: input.maxTokens ?? 4096,
          system: input.system,
          messages,
          tools,
          tool_choice: { type: "tool", name: STRUCTURED_OUTPUT_TOOL_NAME },
        },
        input.signal
      );
      const block = response.content.find((b) => b.type === "tool_use" && b.name === STRUCTURED_OUTPUT_TOOL_NAME);
      if (!block) {
        lastFailureReason = "the model did not call the forced structured-output tool at all";
        continue;
      }
      const result = validateStructuredOutput(block.input, input.schema);
      if (result.valid) {
        return { value: block.input as T, raw: response };
      }
      lastFailureReason = `it failed schema validation: ${result.errors.slice(0, 3).join("; ")}`;
    }

    throw new Error(`${this.name}: model did not return arguments matching schema "${input.schemaName}" after 1 retry (${lastFailureReason})`);
  }

  async analyzeImage(input: AnalyzeImageInput): Promise<GenerateResult> {
    if (!this.capabilities.vision) {
      throw new Error(`${this.name}: vision capability is disabled for this provider configuration`);
    }
    const imageBlock = await toAnthropicImageBlock(input.image);
    const response = await this.post({
      max_tokens: 4096,
      messages: [{ role: "user", content: [{ type: "text", text: input.prompt }, imageBlock] }],
    });
    return { text: textFromBlocks(response.content) };
  }

  private async post(body: Record<string, unknown>, externalSignal?: AbortSignal): Promise<AnthropicResponse> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(new Error(`${this.name}: request exceeded ${this.requestTimeout}ms`)), this.requestTimeout);
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
    const startedAt = Date.now();
    debugLog("model http request started", { baseUrl: this.baseUrl, model: this.options.model });
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
           "content-type": "application/json",
           "x-api-key": this.options.apiKey,
           "anthropic-version": this.options.anthropicVersion ?? "2023-06-01",
          },
        body: JSON.stringify({ model: this.options.model, ...body }),
        signal,
        });
      if (!res.ok) {
        throw new Error(`${this.name}: request failed with ${res.status} ${res.statusText}: ${await res.text()}`);
        }
      const json = (await res.json()) as AnthropicResponse;
      debugLog("model http request finished", { durationMs: Date.now() - startedAt });
      return json;
      } catch (err) {
      debugLog("model http request failed", { durationMs: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) });
      throw err;
      } finally {
      clearTimeout(id);
      }
      }
}

async function toAnthropicMessage(m: Message): Promise<{ role: string; content: unknown }> {
  if (m.role === "tool") {
    return {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: partsToText(m.content) }],
    };
  }
  const content: unknown[] = [];
  for (const p of m.content) {
    if (p.type === "text") content.push({ type: "text", text: p.text });
    else content.push(await toAnthropicImageBlock(p.source));
  }
  if (m.toolCalls?.length) {
    for (const tc of m.toolCalls) {
      content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
    }
  }
  return { role: m.role === "system" ? "user" : m.role, content };
}

async function toAnthropicImageBlock(source: ImageSource): Promise<{ type: "image"; source: { type: "base64"; media_type: string; data: string } }> {
  const mediaType = source.mediaType ?? "image/png";
  if (source.kind === "base64") {
    return { type: "image", source: { type: "base64", media_type: mediaType, data: source.value } };
  }
  if (source.kind === "url") {
    throw new Error("AnthropicProvider: url-kind images are not supported — fetch and pass as base64 or a local path.");
  }
  const bytes = await readFile(source.value);
  return { type: "image", source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") } };
}

function partsToText(parts: ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function textFromBlocks(blocks: AnthropicContentBlock[]): string {
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}
