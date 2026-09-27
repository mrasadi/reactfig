import type {
  AnalyzeImageInput,
  GenerateInput,
  GenerateResult,
  GenerateStructuredInput,
  GenerateStructuredResult,
  GenerateWithToolsInput,
  GenerateWithToolsResult,
  ModelCapabilities,
  ModelProvider,
} from "../types.js";

export interface MockScript {
  capabilities?: Partial<ModelCapabilities>;
  /** Called once per generateWithTools invocation, with a 0-based call index so tests can script a multi-turn tool loop. */
  onGenerateWithTools?: (input: GenerateWithToolsInput, callIndex: number) => GenerateWithToolsResult;
  onGenerateStructured?: (input: GenerateStructuredInput<unknown>, callIndex: number) => unknown;
  onGenerate?: (input: GenerateInput) => GenerateResult;
  onAnalyzeImage?: (input: AnalyzeImageInput) => GenerateResult;
}

/**
 * A fully deterministic, no-network ModelProvider for tests. Scripts are
 * plain functions rather than a fixed response queue so a test can inspect
 * exactly what the orchestration layer sent (which tool, which evidence
 * path, whether an image was attached) before deciding what to return —
 * this is what makes it possible to test "the model asked for X evidence"
 * rather than only "the model eventually returned Y".
 */
export class MockModelProvider implements ModelProvider {
  readonly name = "mock";
  readonly capabilities: ModelCapabilities;

  private toolCallIndex = 0;
  private structuredCallIndex = 0;

  constructor(private readonly script: MockScript) {
    this.capabilities = {
      structuredOutput: true,
      toolCalling: true,
      vision: true,
      ...script.capabilities,
    };
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    if (!this.script.onGenerate) throw new Error("MockModelProvider: no onGenerate script provided");
    return this.script.onGenerate(input);
  }

  async generateStructured<T>(input: GenerateStructuredInput<T>): Promise<GenerateStructuredResult<T>> {
    if (!this.capabilities.structuredOutput) {
      throw new Error(`MockModelProvider: structuredOutput capability disabled, cannot call generateStructured("${input.schemaName}")`);
    }
    if (!this.script.onGenerateStructured) throw new Error("MockModelProvider: no onGenerateStructured script provided");
    const value = this.script.onGenerateStructured(input as GenerateStructuredInput<unknown>, this.structuredCallIndex++) as T;
    return { value, raw: value };
  }

  async generateWithTools(input: GenerateWithToolsInput): Promise<GenerateWithToolsResult> {
    if (!this.capabilities.toolCalling) {
      throw new Error("MockModelProvider: toolCalling capability disabled, cannot call generateWithTools");
    }
    if (!this.script.onGenerateWithTools) throw new Error("MockModelProvider: no onGenerateWithTools script provided");
    return this.script.onGenerateWithTools(input, this.toolCallIndex++);
  }

  async analyzeImage(input: AnalyzeImageInput): Promise<GenerateResult> {
    if (!this.capabilities.vision) {
      throw new Error("MockModelProvider: vision capability disabled, cannot call analyzeImage");
    }
    if (!this.script.onAnalyzeImage) throw new Error("MockModelProvider: no onAnalyzeImage script provided");
    return this.script.onAnalyzeImage(input);
  }
}
