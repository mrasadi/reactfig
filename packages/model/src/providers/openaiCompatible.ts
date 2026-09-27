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
import { readFile } from "node:fs/promises";
import { debugLog } from "../debugLog.js";
import { extractJsonCandidate, validateStructuredOutput } from "../structuredOutput.js";

export interface OpenAICompatibleOptions {
  /** e.g. "http://localhost:11434/v1" for Ollama, "https://api.openai.com/v1" for OpenAI. */
  baseUrl: string;
  apiKey?: string;
  model: string;
  /**
   * Not auto-detected — an arbitrary OpenAI-compatible endpoint doesn't
   * expose a capability-discovery API. Callers must set these based on
   * what they know about the configured model (see docs/analyzer/
   * ai-orchestration.md's provider-setup notes for Qwen 3.6 via Ollama).
   */
  capabilities?: Partial<ModelCapabilities>;
  fetchImpl?: typeof fetch;
  /** Timeout for HTTP requests to the model API in milliseconds. Default 60000. */
  requestTimeout?: number;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

/**
 * Targets any `/chat/completions`-shaped endpoint (Ollama, OpenAI, most
 * self-hosted inference servers). This is what makes "Qwen 3.6 via Ollama"
 * work with zero Qwen-specific code — see ADR 0004.
 *
 * This class is real and type-checked but has not been exercised against a
 * live endpoint in this repository's sandboxed dev environment (no network
 * access to an inference server here) — same disclosed-limitation category
 * as the Playwright browser layer in @reactfig/analyzer. See
 * docs/analyzer/ai-orchestration.md, "Real model smoke test" for how to
 * verify it against a real local model.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string;
  readonly capabilities: ModelCapabilities;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeout: number;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.name = `openai-compatible:${options.model}`;
    this.capabilities = {
      structuredOutput: true,
      toolCalling: true,
      vision: false, // conservative default — many local/OSS models lack vision; opt in explicitly
       ...options.capabilities,
     };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeout = options.requestTimeout ?? 1200000;
   }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const body = await this.buildRequestBody(input);
    const response = await this.post(body, input.signal);
    return { text: extractText(response.choices[0]?.message) };
  }

  async generateWithTools(input: GenerateWithToolsInput): Promise<GenerateWithToolsResult> {
    if (!this.capabilities.toolCalling) {
      throw new Error(`${this.name}: toolCalling capability is disabled for this provider configuration`);
    }
    const body = await this.buildRequestBody(input);
    body.tools = input.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    const response = await this.post(body, input.signal);
    const message = response.choices[0]?.message;
    const toolCalls: ToolCallRequest[] = (message?.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: safeJsonParse(tc.function.arguments),
    }));
    return { text: toolCalls.length > 0 ? null : extractText(message), toolCalls };
  }

  async generateStructured<T>(input: GenerateStructuredInput<T>): Promise<GenerateStructuredResult<T>> {
    if (!this.capabilities.structuredOutput) {
      throw new Error(`${this.name}: structuredOutput capability is disabled for this provider configuration`);
    }
    const baseBody = await this.buildRequestBody(input);
    baseBody.response_format = {
      type: "json_schema",
      json_schema: { name: input.schemaName, schema: input.schema, strict: true },
    };

    // See docs/adr/0014: `response_format: json_schema` is a *request*,
    // not a guarantee — a real OpenAI-compatible/LiteLLM backend has been
    // observed returning Markdown/prose ("## ComponentInterpretation —
    // `SessionCard` ...") instead. generateStructured() must never hand
    // that back as if it were the requested JSON. One bounded corrective
    // retry (not indefinite) gives the model a real chance to comply once
    // told exactly what was wrong; if that also fails, this throws rather
    // than silently accepting prose or fabricating a JSON shape.
    let lastRawText = "";
    let lastFailureReason = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const body =
        attempt === 0
          ? baseBody
          : {
              ...baseBody,
              messages: [
                ...(baseBody.messages as unknown[]),
                {
                  role: "user",
                  content:
                    `Your previous reply was not a single valid JSON object matching the "${input.schemaName}" schema (${lastFailureReason}). ` +
                    `Reply with ONLY the JSON object — no Markdown code fences, no headings, no explanation before or after it.`,
                },
              ],
            };
      const response = await this.post(body, input.signal);
      const text = extractText(response.choices[0]?.message);
      lastRawText = text;

      const candidate = extractJsonCandidate(text);
      if (candidate === undefined) {
        lastFailureReason = "the response was not parseable as JSON at all";
        continue;
      }
      const result = validateStructuredOutput(candidate, input.schema);
      if (result.valid) {
        return { value: candidate as T, raw: response };
      }
      lastFailureReason = `it failed schema validation: ${result.errors.slice(0, 3).join("; ")}`;
    }

    throw new Error(
      `${this.name}: model did not return JSON matching schema "${input.schemaName}" after 1 retry (${lastFailureReason}). ` +
        `Last response started with: ${JSON.stringify(lastRawText.slice(0, 200))}`
    );
  }

  async analyzeImage(input: AnalyzeImageInput): Promise<GenerateResult> {
    if (!this.capabilities.vision) {
      throw new Error(`${this.name}: vision capability is disabled for this provider configuration`);
    }
    const imageUrl = await resolveImageUrl(input.image);
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: input.prompt },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
    };
    const response = await this.post(body);
    return { text: extractText(response.choices[0]?.message) };
  }

  private async buildRequestBody(input: GenerateInput): Promise<Record<string, unknown>> {
    const messages: OpenAIMessage[] = [];
    if (input.system) messages.push({ role: "system", content: input.system });
    for (const m of input.messages) {
      messages.push(await toOpenAIMessage(m));
    }
    return { model: this.options.model, messages, max_tokens: input.maxTokens };
  }

  private async post(
    body: Record<string, unknown>,
    externalSignal?: AbortSignal
  ): Promise<{ choices: { message: OpenAIMessage }[] }> {
    // Two independent reasons a call can end: our own timeout (this.requestTimeout,
    // default 60s per HTTP call — bounds each individual request so a stuck
    // Ollama connection can't hang forever) and an external signal (the
    // caller's own cancellation, e.g. the MCP client disconnected — see
    // docs/adr/0013). AbortSignal.any composes both without either having to
    // know about the other.
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(new Error(`${this.name}: request exceeded ${this.requestTimeout}ms`)), this.requestTimeout);
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
    const startedAt = Date.now();
    debugLog("model http request started", { baseUrl: this.options.baseUrl, model: this.options.model });
    try {
      const res = await this.fetchImpl(`${this.options.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
           "content-type": "application/json",
           ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
         },
        body: JSON.stringify(body),
        signal,
       });
      if (!res.ok) {
        throw new Error(`${this.name}: request failed with ${res.status} ${res.statusText}: ${await res.text()}`);
       }
      const json = (await res.json()) as { choices: { message: OpenAIMessage }[] };
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

async function toOpenAIMessage(m: Message): Promise<OpenAIMessage> {
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.toolCallId, content: partsToText(m.content) };
  }
  const content = await partsToOpenAIContent(m.content);
  const msg: OpenAIMessage = { role: m.role, content };
  if (m.toolCalls?.length) {
    msg.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    }));
  }
  return msg;
}

async function partsToOpenAIContent(parts: ContentPart[]): Promise<OpenAIMessage["content"]> {
  if (parts.every((p) => p.type === "text")) return partsToText(parts);
  const out: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
  for (const p of parts) {
    if (p.type === "text") out.push({ type: "text", text: p.text });
    else out.push({ type: "image_url", image_url: { url: await resolveImageUrl(p.source) } });
  }
  return out;
}

function partsToText(parts: ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

async function resolveImageUrl(source: ImageSource): Promise<string> {
  if (source.kind === "url") return source.value;
  if (source.kind === "base64") return `data:${source.mediaType ?? "image/png"};base64,${source.value}`;
  const bytes = await readFile(source.value);
  return `data:${source.mediaType ?? "image/png"};base64,${bytes.toString("base64")}`;
}

function extractText(message: OpenAIMessage | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  }
  return "";
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
