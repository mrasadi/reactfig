import { describe, it, expect } from "vitest";
import { MockModelProvider } from "../src/providers/mock.js";

describe("MockModelProvider", () => {
  it("defaults all capabilities to true when unspecified", () => {
    const provider = new MockModelProvider({});
    expect(provider.capabilities).toEqual({ structuredOutput: true, toolCalling: true, vision: true });
  });

  it("respects a disabled capability by throwing before the script runs", async () => {
    const provider = new MockModelProvider({ capabilities: { vision: false } });
    await expect(provider.analyzeImage({ image: { kind: "path", value: "x.png" }, prompt: "describe" })).rejects.toThrow(
      /vision capability disabled/
    );
  });

  it("increments the tool-call index across successive generateWithTools calls, letting a script simulate a multi-turn loop", async () => {
    const provider = new MockModelProvider({
      onGenerateWithTools: (_input, callIndex) =>
        callIndex === 0
          ? { text: null, toolCalls: [{ id: "1", name: "get_evidence", arguments: { kind: "source" } }] }
          : { text: "done", toolCalls: [] },
    });
    const first = await provider.generateWithTools({ messages: [], tools: [] });
    expect(first.toolCalls).toHaveLength(1);
    const second = await provider.generateWithTools({ messages: [], tools: [] });
    expect(second.toolCalls).toHaveLength(0);
    expect(second.text).toBe("done");
  });

  it("generateStructured returns the scripted value wrapped with raw", async () => {
    const provider = new MockModelProvider({
      onGenerateStructured: () => ({ hello: "world" }),
    });
    const result = await provider.generateStructured<{ hello: string }>({
      messages: [],
      schemaName: "Test",
      schema: { type: "object" },
    });
    expect(result.value).toEqual({ hello: "world" });
  });

  it("throws a clear error when a required script is missing rather than returning a silent default", async () => {
    const provider = new MockModelProvider({});
    await expect(provider.generateWithTools({ messages: [], tools: [] })).rejects.toThrow(/no onGenerateWithTools script/);
  });
});
