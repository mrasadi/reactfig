import { describe, it, expect } from "vitest";
import { extractJsonCandidate, validateStructuredOutput } from "../src/structuredOutput.js";

describe("extractJsonCandidate — docs/adr/0014-structured-output-and-ir-construction.md", () => {
  it("parses a direct JSON string", () => {
    expect(extractJsonCandidate('{"a":1}')).toEqual({ a: 1 });
  });

  it("recovers JSON from a ```json fenced block", () => {
    const text = 'Here you go:\n```json\n{"a":1}\n```\nHope that helps.';
    expect(extractJsonCandidate(text)).toEqual({ a: 1 });
  });

  it("recovers JSON from a plain (unlabeled) fenced block", () => {
    const text = 'Here you go:\n```\n{"a":1}\n```';
    expect(extractJsonCandidate(text)).toEqual({ a: 1 });
  });

  it("recovers a bare JSON object embedded in prose with no fence", () => {
    const text = 'Sure, the result is {"a":1} — done.';
    expect(extractJsonCandidate(text)).toEqual({ a: 1 });
  });

  it("returns undefined for pure prose with no JSON object anywhere", () => {
    expect(extractJsonCandidate("I have enough evidence. Producing the final interpretation.")).toBeUndefined();
  });

  it("returns undefined for text that merely contains braces but isn't valid JSON", () => {
    expect(extractJsonCandidate("The set {a, b, c} is not empty.")).toBeUndefined();
  });

  it("prefers the fenced block over a stray brace match when both could apply", () => {
    const text = 'Notes: {not json}\n```json\n{"a":1}\n```';
    expect(extractJsonCandidate(text)).toEqual({ a: 1 });
  });
});

describe("validateStructuredOutput", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["componentDisplayName"],
    properties: { componentDisplayName: { type: "string", minLength: 1 } },
  };

  it("accepts a value matching the schema", () => {
    const result = validateStructuredOutput({ componentDisplayName: "SessionCard" }, schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects a value missing a required property, with a readable error", () => {
    const result = validateStructuredOutput({}, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/componentDisplayName/);
  });

  it("rejects a value with an extra property when additionalProperties is false", () => {
    const result = validateStructuredOutput({ componentDisplayName: "X", extra: "nope" }, schema);
    expect(result.valid).toBe(false);
  });
});
