import { describe, it, expect } from "vitest";
import { AnthropicProvider } from "../src/providers/anthropic.js";

describe("AnthropicProvider.generateStructured — docs/adr/0014-structured-output-and-ir-construction.md", () => {
  const SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["componentDisplayName"],
    properties: { componentDisplayName: { type: "string", minLength: 1 } },
  };
  const TOOL_NAME = "__reactfig_structured_output";
  const VALID_VALUE = { componentDisplayName: "SessionCard" };

  function toolUseResponse(input: unknown) {
    return { content: [{ type: "tool_use", id: "1", name: TOOL_NAME, input }], stop_reason: "tool_use" };
  }
  function textOnlyResponse(text: string) {
    return { content: [{ type: "text", text }], stop_reason: "end_turn" };
  }

  function providerWithResponses(bodies: unknown[]): { provider: AnthropicProvider; getCalls: () => number } {
    let callIndex = 0;
    let calls = 0;
    const mockFetch: typeof fetch = async () => {
      calls++;
      const body = bodies[Math.min(callIndex, bodies.length - 1)];
      callIndex++;
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    };
    const provider = new AnthropicProvider({ apiKey: "test-key", model: "claude-sonnet-5", fetchImpl: mockFetch, requestTimeout: 5000 });
    return { provider, getCalls: () => calls };
  }

  it("returns the tool call's input on a well-behaved first response", async () => {
    const { provider } = providerWithResponses([toolUseResponse(VALID_VALUE)]);
    const result = await provider.generateStructured({ messages: [], schemaName: "ComponentInterpretation", schema: SCHEMA });
    expect(result.value).toEqual(VALID_VALUE);
  });

  it("retries once and succeeds when the model answers in text instead of calling the forced tool", async () => {
    const { provider, getCalls } = providerWithResponses([textOnlyResponse("Sure, here's my analysis..."), toolUseResponse(VALID_VALUE)]);
    const result = await provider.generateStructured({ messages: [], schemaName: "ComponentInterpretation", schema: SCHEMA });
    expect(result.value).toEqual(VALID_VALUE);
    expect(getCalls()).toBe(2);
  });

  it("retries once and succeeds when the tool call's arguments fail schema validation the first time", async () => {
    const { provider, getCalls } = providerWithResponses([toolUseResponse({ componentDisplayName: "" }), toolUseResponse(VALID_VALUE)]);
    const result = await provider.generateStructured({ messages: [], schemaName: "ComponentInterpretation", schema: SCHEMA });
    expect(result.value).toEqual(VALID_VALUE);
    expect(getCalls()).toBe(2);
  });

  it("throws a clear error after exactly one bounded retry — never returns invalid/absent structured data", async () => {
    const { provider, getCalls } = providerWithResponses([textOnlyResponse("no tool call"), textOnlyResponse("still no tool call")]);
    await expect(
      provider.generateStructured({ messages: [], schemaName: "ComponentInterpretation", schema: SCHEMA })
    ).rejects.toThrow(/did not return arguments matching schema "ComponentInterpretation" after 1 retry/);
    expect(getCalls()).toBe(2);
  });
});
