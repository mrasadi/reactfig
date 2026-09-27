import { describe, it, expect } from "vitest";
import { OpenAICompatibleProvider } from "../src/providers/openaiCompatible.js";

describe("OpenAICompatibleProvider requestTimeout", () => {
  it("aborts the request when fetch never resolves", async () => {
    let abortDetected = false;
    const mockFetch: typeof fetch = async (_url, opts) => {
       // Simulate a real fetch that properly handles AbortController
      await new Promise<void>((_resolve, reject) => {
        const signal = opts?.signal;
        if (signal) {
          signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
         }
         // Never resolves on its own — only abort will trigger rejection
       });
      return new Response("", {});
     };

    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://localhost:11434/v1",
      model: "test-model",
      fetchImpl: mockFetch,
      requestTimeout: 50,
     });

    const start = Date.now();
    await expect(provider.generate({ messages: [], system: "test" })).rejects.toThrow("abort");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThan(30);
    expect(elapsed).toBeLessThan(200);
   });

  it("does NOT abort when the request completes within the budget", async () => {
    let fetchCalled = false;
    const mockFetch: typeof fetch = async (url, opts) => {
      fetchCalled = true;
       // Check signal is not prematurely aborted
      if (opts?.signal?.aborted) throw new Error("Signal was prematurely aborted");
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hello" } }] }), {
        headers: { "content-type": "application/json" },
       });
     };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://localhost:11434/v1",
      model: "test-model",
      fetchImpl: mockFetch,
      requestTimeout: 5000,
     });

    const result = await provider.generate({ messages: [], system: "test" });
    expect(fetchCalled).toBe(true);
    expect(result.text).toBe("hello");
   });
});

describe("OpenAICompatibleProvider external cancellation — docs/adr/0013-generate-design-ir-timeout.md", () => {
  it("aborts immediately when the caller's own signal fires, independent of requestTimeout", async () => {
    const mockFetch: typeof fetch = async (_url, opts) => {
      const signal = opts?.signal;
      if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
      });
      return new Response("", {});
    };

    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://localhost:11434/v1",
      model: "test-model",
      fetchImpl: mockFetch,
      requestTimeout: 60_000, // deliberately long — the external signal must win first
    });

    const externalController = new AbortController();
    externalController.abort(); // aborted before the call — deterministic, no race with the microtask that wires up the combined signal
    const start = Date.now();
    await expect(provider.generate({ messages: [], system: "test", signal: externalController.signal })).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("rejects synchronously-obvious cancellation for generateWithTools and generateStructured too, not just generate", async () => {
    const mockFetch: typeof fetch = async (_url, opts) => {
      const signal = opts?.signal;
      if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
      });
      return new Response("", {});
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://localhost:11434/v1",
      model: "test-model",
      fetchImpl: mockFetch,
      requestTimeout: 60_000,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.generateWithTools({ messages: [], tools: [], signal: controller.signal })
    ).rejects.toThrow();
    await expect(
      provider.generateStructured({ messages: [], schemaName: "X", schema: {}, signal: controller.signal })
    ).rejects.toThrow();
  });

  it("does not abort when only the (unfired) external signal is present and the request completes normally", async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
        headers: { "content-type": "application/json" },
      });
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://localhost:11434/v1",
      model: "test-model",
      fetchImpl: mockFetch,
      requestTimeout: 5000,
    });
    const controller = new AbortController(); // never aborted
    const result = await provider.generate({ messages: [], signal: controller.signal });
    expect(result.text).toBe("ok");
  });
});

describe("OpenAICompatibleProvider.generateStructured — docs/adr/0014-structured-output-and-ir-construction.md", () => {
  const SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["componentDisplayName", "variantAxes", "nodeAnnotations"],
    properties: {
      componentDisplayName: { type: "string", minLength: 1 },
      variantAxes: { type: "array", items: {} },
      nodeAnnotations: { type: "array", items: {} },
    },
  };
  const VALID_VALUE = { componentDisplayName: "SessionCard", variantAxes: [], nodeAnnotations: [] };

  function providerWithResponses(bodies: string[]): { provider: OpenAICompatibleProvider; calls: number[] } {
    let callIndex = 0;
    const calls: number[] = [];
    const mockFetch: typeof fetch = async () => {
      calls.push(callIndex);
      const content = bodies[Math.min(callIndex, bodies.length - 1)];
      callIndex++;
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
        headers: { "content-type": "application/json" },
      });
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://localhost:4000/v1",
      model: "vision",
      fetchImpl: mockFetch,
      requestTimeout: 5000,
    });
    return { provider, calls };
  }

  it("parses a well-behaved direct JSON response on the first attempt", async () => {
    const { provider, calls } = providerWithResponses([JSON.stringify(VALID_VALUE)]);
    const result = await provider.generateStructured({ messages: [], schemaName: "ComponentInterpretation", schema: SCHEMA });
    expect(result.value).toEqual(VALID_VALUE);
    expect(calls).toHaveLength(1);
  });

  it("recovers JSON from a fenced code block wrapped in prose — the exact real-world failure mode", async () => {
    const markdown =
      "I have enough evidence. Producing the final interpretation.\n\n" +
      "## ComponentInterpretation — `SessionCard`\n\n" +
      "**Purpose:** displays a scheduled session.\n\n" +
      "```json\n" +
      JSON.stringify(VALID_VALUE, null, 2) +
      "\n```\n";
    const { provider, calls } = providerWithResponses([markdown]);
    const result = await provider.generateStructured({ messages: [], schemaName: "ComponentInterpretation", schema: SCHEMA });
    expect(result.value).toEqual(VALID_VALUE);
    expect(calls).toHaveLength(1); // recovered without needing the retry
  });

  it("recovers a bare JSON object surrounded by prose with no code fence at all", async () => {
    const prose = `Sure, here it is: ${JSON.stringify(VALID_VALUE)} — let me know if you need anything else.`;
    const { provider } = providerWithResponses([prose]);
    const result = await provider.generateStructured({ messages: [], schemaName: "ComponentInterpretation", schema: SCHEMA });
    expect(result.value).toEqual(VALID_VALUE);
  });

  it("retries once with corrective feedback when the first response is pure unparseable Markdown, then succeeds", async () => {
    const pureMarkdown = "I have enough evidence. Producing the final interpretation.\n\n## ComponentInterpretation — `SessionCard`\n\n**Purpose:** ...";
    const { provider, calls } = providerWithResponses([pureMarkdown, JSON.stringify(VALID_VALUE)]);
    const result = await provider.generateStructured({ messages: [{ role: "user", content: [{ type: "text", text: "go" }] }], schemaName: "ComponentInterpretation", schema: SCHEMA });
    expect(result.value).toEqual(VALID_VALUE);
    expect(calls).toHaveLength(2);
  });

  it("throws a clear error — never returns Markdown as if it were the value — when both attempts fail", async () => {
    const pureMarkdown = "## ComponentInterpretation\n\nNo JSON here at all, just prose.";
    const { provider, calls } = providerWithResponses([pureMarkdown, pureMarkdown]);
    await expect(
      provider.generateStructured({ messages: [], schemaName: "ComponentInterpretation", schema: SCHEMA })
    ).rejects.toThrow(/did not return JSON matching schema "ComponentInterpretation" after 1 retry/);
    expect(calls).toHaveLength(2); // exactly one bounded retry, not indefinite
  });

  it("retries once when the response is syntactically valid JSON but fails schema validation, then succeeds", async () => {
    const invalidShape = JSON.stringify({ componentDisplayName: "", variantAxes: [], nodeAnnotations: [] }); // minLength:1 violated
    const { provider, calls } = providerWithResponses([invalidShape, JSON.stringify(VALID_VALUE)]);
    const result = await provider.generateStructured({ messages: [], schemaName: "ComponentInterpretation", schema: SCHEMA });
    expect(result.value).toEqual(VALID_VALUE);
    expect(calls).toHaveLength(2);
  });

  it("never accepts a schema-invalid value even after the retry — validates on every attempt, not just parses", async () => {
    const invalidShape = JSON.stringify({ componentDisplayName: "", variantAxes: [], nodeAnnotations: [] });
    const { provider } = providerWithResponses([invalidShape, invalidShape]);
    await expect(
      provider.generateStructured({ messages: [], schemaName: "ComponentInterpretation", schema: SCHEMA })
    ).rejects.toThrow(/schema validation/);
  });
});
