/**
 * Opt-in smoke test against a REAL configured model provider. Not part of
 * `vitest run` / the default test suite (see package.json — this file has
 * no .test.ts extension and vitest is not configured to pick it up).
 *
 * Run manually, after building the workspace (this script imports from
 * ../dist and sibling packages' dist output — Node's native TS
 * type-stripping doesn't remap a `.js` import specifier to a sibling `.ts`
 * file, so it must run against built output, same as
 * packages/artifact/scripts/inspect-cli.ts):
 *
 *   pnpm -r build
 *   cd packages/analyzer
 *
 *   # against Qwen 3.6 (or any model) served locally via Ollama:
 *   ollama pull qwen3.6
 *   ollama serve   # if not already running
 *   REACTFIG_SMOKE_BASE_URL=http://localhost:11434/v1 \
 *   REACTFIG_SMOKE_MODEL=qwen3.6 \
 *   node scripts/smoke-test-real-model.js   # after building this script too, or run via tsx/ts-node
 *
 *   # against Anthropic:
 *   REACTFIG_SMOKE_PROVIDER=anthropic \
 *   ANTHROPIC_API_KEY=sk-... \
 *   REACTFIG_SMOKE_MODEL=claude-sonnet-5 \
 *   node scripts/smoke-test-real-model.js
 *
 * Requires nothing to be installed to run the normal repository test
 * suite — this script is never invoked by `pnpm test` / CI.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OpenAICompatibleProvider, AnthropicProvider, type ModelProvider } from "@reactfig/model";
import { inspectComponentSource } from "../dist/ast/inspectComponentSource.js";
import { interpretDomSnapshot } from "../dist/evidence/interpretDomSnapshot.js";
import { buildComponentEvidence } from "../dist/buildComponentEvidence.js";
import { generateDesignIR } from "../dist/ai/orchestrate.js";
import type { RawDomSnapshot } from "../src/browser/rawTypes.js";
import type { RenderCapture } from "../src/evidence/types.js";

function fixturePath(rel: string): string {
  return fileURLToPath(new URL(`../test/fixtures/${rel}`, import.meta.url));
}

function loadRaw(name: string): RawDomSnapshot {
  return JSON.parse(readFileSync(fixturePath(`raw-snapshots/${name}.json`), "utf-8"));
}

function toCapture(label: string, raw: RawDomSnapshot, propValues?: Record<string, unknown>): RenderCapture {
  return {
    label,
    viewport: { width: 1440, height: 900 },
    propValues,
    dom: interpretDomSnapshot(raw),
    screenshot: null,
    contextScreenshot: null,
    capturedUrl: "http://localhost:3000",
    capturedAt: new Date().toISOString(),
  };
}

function buildProvider(): ModelProvider {
  if (process.env.REACTFIG_SMOKE_PROVIDER === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for the anthropic smoke test");
    return new AnthropicProvider({
      apiKey,
      model: process.env.REACTFIG_SMOKE_MODEL ?? "claude-sonnet-5",
      capabilities: { vision: true },
    });
  }
  return new OpenAICompatibleProvider({
    baseUrl: process.env.REACTFIG_SMOKE_BASE_URL ?? "http://localhost:11434/v1",
    model: process.env.REACTFIG_SMOKE_MODEL ?? "qwen3.6",
    capabilities: { vision: false, toolCalling: true, structuredOutput: true },
  });
}

async function main() {
  const provider = buildProvider();
  console.log(`Smoke-testing generateDesignIR against ${provider.name} (capabilities: ${JSON.stringify(provider.capabilities)})`);

  const source = inspectComponentSource(fixturePath("react/Button.tsx"));
  const captures = [
    toCapture("default", loadRaw("button-default"), { variant: "primary", size: "medium" }),
    toCapture("variant=secondary,size=large", loadRaw("button-secondary-large"), { variant: "secondary", size: "large" }),
  ];
  const evidence = buildComponentEvidence({ componentName: "Button", source, captures, analyzerVersion: "smoke-test" });

  const result = await generateDesignIR(provider, evidence, { maxRepairAttempts: 1 });

  console.log(`attempts: ${result.attempts}, toolCallCount: ${result.toolCallCount}, valid: ${result.validation.valid}`);
  if (!result.validation.valid) {
    console.error("Validation errors:", result.validation.errors);
    process.exitCode = 1;
    return;
  }
  console.log("Interpretation:", JSON.stringify(result.interpretation, null, 2));
  console.log("Design IR component count:", result.document.components.length);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
