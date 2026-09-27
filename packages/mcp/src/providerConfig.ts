import { AnthropicProvider, OpenAICompatibleProvider, type ModelCapabilities, type ModelProvider } from "@reactfig/model";

/**
 * The MCP server configures its model provider once, at startup, from
 * environment variables — not per tool call. This keeps tool argument
 * schemas focused on "what component to analyze," not "which model to
 * use this time," which matches how every other MCP server handles
 * provider credentials (env vars, not request payloads).
 *
 * REACTFIG_MODEL_PROVIDER=openai-compatible (default) | anthropic
 *
 * openai-compatible (Ollama/Qwen 3.6, OpenAI, self-hosted):
 *   REACTFIG_MODEL_BASE_URL   e.g. http://localhost:11434/v1
 *   REACTFIG_MODEL_NAME       e.g. qwen3.6
 *   REACTFIG_MODEL_API_KEY    optional
 *   REACTFIG_MODEL_VISION     "true" | "false" (default false — see @reactfig/model's conservative default)
 *   REACTFIG_MODEL_TOOLS      "true" | "false" (default true)
 *
 * anthropic:
 *   REACTFIG_MODEL_NAME       e.g. claude-sonnet-5
 *   ANTHROPIC_API_KEY         required
 */
export function createProviderFromEnv(env: NodeJS.ProcessEnv = process.env): ModelProvider {
  const kind = env.REACTFIG_MODEL_PROVIDER ?? "openai-compatible";

  if (kind === "anthropic") {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("createProviderFromEnv: REACTFIG_MODEL_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set");
    }
    return new AnthropicProvider({
      apiKey,
      model: env.REACTFIG_MODEL_NAME ?? "claude-sonnet-5",
    });
  }

  if (kind === "openai-compatible") {
    // No defaults here on purpose: a silently-wrong base URL or model name
    // (e.g. an earlier version of this function defaulted the model to the
    // literal string "vision") fails in a confusing, hard-to-diagnose way
    // deep inside a request instead of at startup. Both must be explicit.
    const baseUrl = env.REACTFIG_MODEL_BASE_URL;
    const model = env.REACTFIG_MODEL_NAME;
    if (!baseUrl || !model) {
      throw new Error(
        "createProviderFromEnv: REACTFIG_MODEL_PROVIDER=openai-compatible requires REACTFIG_MODEL_BASE_URL and REACTFIG_MODEL_NAME to be set"
      );
    }
    const capabilities: Partial<ModelCapabilities> = {
      vision: parseBool(env.REACTFIG_MODEL_VISION, false),
      toolCalling: parseBool(env.REACTFIG_MODEL_TOOLS, true),
    };
    return new OpenAICompatibleProvider({ baseUrl, model, apiKey: env.REACTFIG_MODEL_API_KEY ?? "sk-local-1234", capabilities });
  }

  throw new Error(`createProviderFromEnv: unknown REACTFIG_MODEL_PROVIDER "${kind}" — expected "openai-compatible" or "anthropic"`);
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}
