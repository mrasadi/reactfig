import { describe, it, expect } from "vitest";
import { createProviderFromEnv } from "../src/providerConfig.js";

describe("createProviderFromEnv", () => {
  it("defaults to openai-compatible and requires baseUrl + model", () => {
    expect(() => createProviderFromEnv({})).toThrow(/requires REACTFIG_MODEL_BASE_URL and REACTFIG_MODEL_NAME/);
  });

  it("builds an OpenAICompatibleProvider with conservative default capabilities", () => {
    const provider = createProviderFromEnv({
      REACTFIG_MODEL_BASE_URL: "http://localhost:11434/v1",
      REACTFIG_MODEL_NAME: "qwen3.6",
    });
    expect(provider.name).toBe("openai-compatible:qwen3.6");
    expect(provider.capabilities).toEqual({ structuredOutput: true, toolCalling: true, vision: false });
  });

  it("respects REACTFIG_MODEL_VISION=true", () => {
    const provider = createProviderFromEnv({
      REACTFIG_MODEL_BASE_URL: "http://localhost:11434/v1",
      REACTFIG_MODEL_NAME: "qwen3.6",
      REACTFIG_MODEL_VISION: "true",
    });
    expect(provider.capabilities.vision).toBe(true);
  });

  it("builds an AnthropicProvider and requires ANTHROPIC_API_KEY", () => {
    expect(() => createProviderFromEnv({ REACTFIG_MODEL_PROVIDER: "anthropic" })).toThrow(/requires ANTHROPIC_API_KEY/);

    const provider = createProviderFromEnv({
      REACTFIG_MODEL_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-test",
      REACTFIG_MODEL_NAME: "claude-sonnet-5",
    });
    expect(provider.name).toBe("anthropic:claude-sonnet-5");
  });

  it("throws a clear error for an unknown provider kind", () => {
    expect(() => createProviderFromEnv({ REACTFIG_MODEL_PROVIDER: "bogus" })).toThrow(/unknown REACTFIG_MODEL_PROVIDER "bogus"/);
  });
});
