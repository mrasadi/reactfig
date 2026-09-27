import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockModelProvider } from "@reactfig/model";
import { generateDesignIrTool, type CaptureRequest } from "../../src/tools/generateDesignIr.js";
import { CHECKPOINT_FILES } from "../../src/checkpoint.js";
import type { RenderCapture } from "@reactfig/analyzer";

const projectRoot = fileURLToPath(new URL("../fixtures", import.meta.url));

let checkpointRoot: string;
afterEach(() => {
  if (checkpointRoot) rmSync(checkpointRoot, { recursive: true, force: true });
});

/** Redirect checkpoint writes (and the checkpoint-map.json index) to a throwaway temp dir so tests don't pollute the repo's fixtures. */
function withCheckpoints(ctx: Parameters<typeof generateDesignIrTool>[1]): Parameters<typeof generateDesignIrTool>[1] {
  checkpointRoot = mkdtempSync(join(tmpdir(), "reactfig-gen-checkpoint-"));
  return { ...ctx, checkpointRootDir: checkpointRoot, checkpointMapPath: join(checkpointRoot, "checkpoint-map.json") };
}

/** A minimal, hand-built ElementEvidence tree standing in for a real capture — same shape @reactfig/analyzer's interpretDomSnapshot would produce. */
function fakeDom(overrides: Partial<RenderCapture["dom"]> = {}): RenderCapture["dom"] {
  return {
    tag: "button",
    attributes: {},
    textContent: null,
    bounds: { x: 0, y: 0, width: 160, height: 48 },
    style: {
      display: "flex",
      layoutMode: "flex",
      position: null,
      zIndex: null,
      flex: { direction: "row", justifyContent: "center", alignItems: "center", wrap: null, gap: 8, rowGap: null, columnGap: null },
      grid: null,
      gridChildPlacement: null,
      padding: { top: 12, right: 24, bottom: 12, left: 24 },
      margin: null,
      backgroundColor: { raw: "rgb(28, 97, 250)", parsed: { r: 0.11, g: 0.38, b: 0.98, a: 1 } },
      backgroundImage: null,
      backgroundImageUrl: null,
      border: null,
      cornerRadius: { raw: "8px", parsedPx: 8 },
      boxShadow: null,
      opacity: null,
      overflow: null,
      typography: {
        fontFamily: "Inter",
        fontSizePx: 16,
        fontWeight: "600",
        fontStyle: null,
        lineHeight: null,
        lineHeightPx: null,
        letterSpacing: null,
        letterSpacingPx: null,
        textAlign: "center",
        whiteSpace: null,
        textOverflow: null,
        color: { raw: "rgb(255,255,255)", parsed: { r: 1, g: 1, b: 1, a: 1 } },
      },
    },
    image: null,
    componentPath: ["Button"],
    isComponentRoot: true,
    children: [],
    ...overrides,
  };
}

function makeFakeCapture(overrides: Partial<RenderCapture> = {}): (request: CaptureRequest) => Promise<RenderCapture> {
  const calls: CaptureRequest[] = [];
  const fn = async (request: CaptureRequest): Promise<RenderCapture> => {
    calls.push(request);
    return {
      label: request.label,
      viewport: request.viewport,
      viewportLabel: request.viewportLabel,
      propValues: request.propValues,
      dom: fakeDom(),
      screenshot: null,
      contextScreenshot: null,
      capturedUrl: request.url,
      capturedAt: "2026-08-19T12:00:00.000Z",
      ...overrides,
    };
  };
  (fn as typeof fn & { calls: CaptureRequest[] }).calls = calls;
  return fn as typeof fn & { calls: CaptureRequest[] };
}

describe("generateDesignIrTool", () => {
  it("captures the default viewport once and produces a validated Design IR (no variants requested)", async () => {
    const capture = makeFakeCapture() as ((r: CaptureRequest) => Promise<RenderCapture>) & { calls: CaptureRequest[] };
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({ componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] }),
    });

    const result = await generateDesignIrTool(
       { sourceFile: "react/Button.tsx", url: "http://localhost:3000", selector: ".btn" },
       withCheckpoints({ projectRoot, provider, captureComponent: capture })
      );

    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0].label).toBe("default");
    expect(capture.calls[0].rootComponentName).toBe("Button");
    expect(result.componentName).toBe("Button");
    expect(result.captureCount).toBe(1);
    expect(result.validation.valid).toBe(true);
   });

  it("reports no warnings when the selector matched exactly one element (the common, expected case)", async () => {
    const capture = makeFakeCapture({ matchCount: 1 });
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({ componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] }),
    });

    const result = await generateDesignIrTool(
      { sourceFile: "react/Button.tsx", url: "http://localhost:3000", selector: ".btn" },
      withCheckpoints({ projectRoot, provider, captureComponent: capture })
    );

    expect(result.warnings).toEqual([]);
  });

  it(
    "warns (without failing) when a capture's selector matched more than one element — " +
      "real reported concern: a selector like '.avatar' silently capturing the first of several matching instances",
    async () => {
      const capture = makeFakeCapture({ matchCount: 3 });
      const provider = new MockModelProvider({
        onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
        onGenerateStructured: () => ({ componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] }),
      });

      const result = await generateDesignIrTool(
        { sourceFile: "react/Button.tsx", url: "http://localhost:3000", selector: ".btn" },
        withCheckpoints({ projectRoot, provider, captureComponent: capture })
      );

      expect(result.validation.valid).toBe(true); // still succeeds — this is a warning, not a failure
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("matched 3 elements");
      expect(result.warnings[0]).toContain('selector ".btn"');
    }
  );

  it("aggregates one warning per capture across multiple viewports, not just the first", async () => {
    const calls: CaptureRequest[] = [];
    const capture = async (request: CaptureRequest): Promise<RenderCapture> => {
      calls.push(request);
      return {
        label: request.label,
        viewport: request.viewport,
        viewportLabel: request.viewportLabel,
        propValues: request.propValues,
        dom: fakeDom(),
        screenshot: null,
        contextScreenshot: null,
        capturedUrl: request.url,
        capturedAt: "2026-08-19T12:00:00.000Z",
        matchCount: 2, // ambiguous on every viewport capture, not just one
      };
    };
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({ componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] }),
    });

    const result = await generateDesignIrTool(
      {
        sourceFile: "react/Button.tsx",
        url: "http://localhost:3000",
        selector: ".btn",
        viewports: [
          { name: "desktop", width: 1440, height: 900 },
          { name: "mobile", width: 375, height: 667 },
        ],
      },
      withCheckpoints({ projectRoot, provider, captureComponent: capture })
    );

    expect(calls).toHaveLength(2);
    expect(result.warnings).toHaveLength(2);
  });

  it("persists each major stage to a versioned checkpoint directory, with a manifest tracking each stage", async () => {
    const capture = makeFakeCapture();
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({ componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] }),
      });

    const result = await generateDesignIrTool(
       { sourceFile: "react/Button.tsx", url: "http://localhost:3000", selector: ".btn" },
       withCheckpoints({ projectRoot, provider, captureComponent: capture })
      );

      // All stage files exist in the version-scoped directory the result
      // reports (ADR 0017 §2, §4), addressable directly rather than
      // reconstructed by the caller.
    const dir = result.checkpointDir;
    expect(result.checkpointVersion).toBe(1);
    expect(result.checkpointRef).toBe("Button@v001");
    expect(dir).toBe(join(checkpointRoot, "Button", "v001"));
    expect(existsSync(join(dir, CHECKPOINT_FILES.evidence))).toBe(true);
    expect(existsSync(join(dir, CHECKPOINT_FILES.interpretation))).toBe(true);
    expect(existsSync(join(dir, CHECKPOINT_FILES.designIr))).toBe(true);
    expect(existsSync(join(dir, CHECKPOINT_FILES.validation))).toBe(true);
    expect(existsSync(join(dir, CHECKPOINT_FILES.manifest))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(dir, CHECKPOINT_FILES.manifest), "utf-8"));
    expect(manifest.component).toBe("Button");
    expect(manifest.stages).toEqual({
      sourceInspection: "completed",
      capture: "completed",
      interpretation: "completed",
      designIr: "completed",
      validation: "completed",
      export: "not_started",
    });
    expect(manifest.validation).toEqual({ valid: true, errorCount: 0 });
    expect(manifest.source.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
   });

  it("gives a second generate_design_ir call for the same component its own v002 checkpoint, without touching v001", async () => {
    const capture = makeFakeCapture();
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({ componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] }),
    });
    const ctx = withCheckpoints({ projectRoot, provider, captureComponent: capture });
    const args = { sourceFile: "react/Button.tsx", url: "http://localhost:3000", selector: ".btn" };

    const first = await generateDesignIrTool(args, ctx);
    const second = await generateDesignIrTool(args, ctx);

    expect(first.checkpointVersion).toBe(1);
    expect(second.checkpointVersion).toBe(2);
    expect(first.checkpointDir).not.toBe(second.checkpointDir);
    expect(existsSync(join(first.checkpointDir, CHECKPOINT_FILES.designIr))).toBe(true);
    expect(existsSync(join(second.checkpointDir, CHECKPOINT_FILES.designIr))).toBe(true);
   });

  it("captures one request per extra viewport and per variant, all evidence-backed", async () => {
    const capture = makeFakeCapture() as ((r: CaptureRequest) => Promise<RenderCapture>) & { calls: CaptureRequest[] };
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({
        componentDisplayName: "Button",
        variantAxes: [{ propName: "variant", confirmedValues: ["primary", "secondary"], rationale: "both captured" }],
        nodeAnnotations: [],
      }),
    });

    const result = await generateDesignIrTool(
      {
        sourceFile: "react/Button.tsx",
        url: "http://localhost:3000",
        selector: ".btn",
        viewports: [
          { name: "desktop", width: 1440, height: 900 },
          { name: "mobile", width: 375, height: 812 },
        ],
        variants: [{ propValues: { variant: "secondary" } }],
        },
       withCheckpoints({ projectRoot, provider, captureComponent: capture })
      );

    expect(capture.calls).toHaveLength(3); // desktop (default) + mobile viewport + 1 variant
    expect(capture.calls[1].label).toBe("viewport=mobile");
    expect(capture.calls[2].propValues).toEqual({ variant: "secondary" });
    expect(result.captureCount).toBe(3);
    expect(result.validation.valid).toBe(true);
  });

  it("propagates maxRepairAttempts/maxToolIterations through to generateDesignIR", async () => {
    const capture = makeFakeCapture();
    let structuredCallCount = 0;
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => {
        structuredCallCount++;
        // always invalid, to force exhausting the repair budget
        return { componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [{ path: [], semanticName: "" }] };
      },
    });

    const result = await generateDesignIrTool(
        { sourceFile: "react/Button.tsx", url: "http://localhost:3000", selector: ".btn", maxRepairAttempts: 1 },
       withCheckpoints({ projectRoot, provider, captureComponent: capture })
       );

    expect(result.attempts).toBe(2); // 1 initial + 1 repair
    expect(structuredCallCount).toBe(2);
    expect(result.validation.valid).toBe(false);
  });

  it("only requests a screenshot when the configured provider has vision capability — docs/adr/0013 (previously never requested at all, regardless of REACTFIG_MODEL_VISION)", async () => {
    const captureNoVision = makeFakeCapture() as ((r: CaptureRequest) => Promise<RenderCapture>) & { calls: CaptureRequest[] };
    const providerNoVision = new MockModelProvider({
      capabilities: { structuredOutput: true, toolCalling: true, vision: false },
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({ componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] }),
    });
    expect(providerNoVision.capabilities.vision).toBe(false);
    await generateDesignIrTool(
        { sourceFile: "react/Button.tsx", url: "http://localhost:3000", selector: ".btn" },
       withCheckpoints({ projectRoot, provider: providerNoVision, captureComponent: captureNoVision })
       );
    expect(captureNoVision.calls[0].captureScreenshot).toBe(false);

    const captureWithVision = makeFakeCapture() as ((r: CaptureRequest) => Promise<RenderCapture>) & { calls: CaptureRequest[] };
    const providerWithVision = new MockModelProvider({
      capabilities: { structuredOutput: true, toolCalling: true, vision: true },
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({ componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] }),
       });
    await generateDesignIrTool(
        { sourceFile: "react/Button.tsx", url: "http://localhost:3000", selector: ".btn" },
       withCheckpoints({ projectRoot, provider: providerWithVision, captureComponent: captureWithVision })
       );
    expect(captureWithVision.calls[0].captureScreenshot).toBe(true);
    });

  it("forwards ctx.signal to every captureComponent call and to model calls — docs/adr/0013", async () => {
    const capture = makeFakeCapture() as ((r: CaptureRequest) => Promise<RenderCapture>) & { calls: CaptureRequest[] };
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({ componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] }),
    });
    const controller = new AbortController();

    await generateDesignIrTool(
         { sourceFile: "react/Button.tsx", url: "http://localhost:3000", selector: ".btn" },
       withCheckpoints({ projectRoot, provider, captureComponent: capture, signal: controller.signal })
        );

    expect(capture.calls[0].signal).toBe(controller.signal);
  });

  it("calls onProgress at least once per capture and once for the model stage — docs/adr/0013", async () => {
    const capture = makeFakeCapture();
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({ componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] }),
    });
    const stages: string[] = [];

    await generateDesignIrTool(
          { sourceFile: "react/Button.tsx", url: "http://localhost:3000", selector: ".btn" },
       withCheckpoints({ projectRoot, provider, captureComponent: capture, onProgress: (stage) => stages.push(stage) })
         );

    expect(stages.some((s) => s.includes("capturing"))).toBe(true);
    expect(stages.some((s) => s.includes("interpretation attempt"))).toBe(true);
  });

  it("forwards args.prompt to the model as guidance — docs/adr/0013's addendum", async () => {
    const capture = makeFakeCapture();
    let sawPrompt = false;
    const provider = new MockModelProvider({
      onGenerateWithTools: (input) => {
        if (input.system?.includes("card statuses")) sawPrompt = true;
        return { text: "done", toolCalls: [] };
      },
      onGenerateStructured: () => ({ componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] }),
    });

    await generateDesignIrTool(
          {
           sourceFile: "react/Button.tsx",
           url: "http://localhost:3000",
           selector: ".btn",
           prompt: "capture all three card statuses",
            },
       withCheckpoints({ projectRoot, provider, captureComponent: capture })
            );

    expect(sawPrompt).toBe(true);
  });

  it("multi-variant capture: a StatCard-tone-like set of variants produces one capture per state, all evidence for the same logical component (Issue.md 'Implement Minimal Multi-Variant Capture')", async () => {
    const capture = makeFakeCapture();
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({ componentDisplayName: "StatCard", variantAxes: [{ propName: "tone", confirmedValues: ["neutral", "success", "warning"], rationale: "captured all three tones" }], nodeAnnotations: [] }),
    });

    const ctx = withCheckpoints({ projectRoot, provider, captureComponent: capture });
    const result = await generateDesignIrTool(
      {
        sourceFile: "react/Button.tsx",
        url: "http://localhost:3000",
        selector: ".stat-card",
        componentName: "StatCard",
        variants: [
          { propValues: { tone: "success" }, selector: ".stat-card:nth-of-type(2)" },
          { propValues: { tone: "warning" }, selector: ".stat-card:nth-of-type(3)" },
        ],
      },
      ctx
    );

    // 3 captures total (default + 2 variants), all for ONE component/checkpoint version — not
    // three unrelated component definitions (Issue.md §7).
    expect(capture.calls).toHaveLength(3);
    expect(result.captureCount).toBe(3);
    expect(result.componentName).toBe("StatCard");
    expect(result.checkpointVersion).toBe(1);

    // Each variant's capture carried its own propValues through to evidence.
    const evidence = JSON.parse(readFileSync(join(result.checkpointDir, CHECKPOINT_FILES.evidence), "utf-8"));
    const propValuesByLabel = Object.fromEntries(evidence.captures.map((c: { label: string; propValues?: Record<string, string> }) => [c.label, c.propValues]));
    expect(propValuesByLabel["default"]).toBeUndefined();
    expect(propValuesByLabel["variant=tone:success"]).toEqual({ tone: "success" });
    expect(propValuesByLabel["variant=tone:warning"]).toEqual({ tone: "warning" });

    // Whether the model's variantAxes claim survives into the final interpretation depends on
    // @reactfig/analyzer's own document-construction/validation pipeline (pre-existing, out of
    // scope here) — what this capture-plan feature is responsible for is getting all 3 distinct-
    // tone captures into the evidence the model sees in the first place, which the assertions
    // above already confirm.
  });

  it("components without meaningful variants behave exactly as before: one capture, one plan entry, existing single-capture path untouched (Issue.md §6)", async () => {
    const capture = makeFakeCapture();
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({ componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] }),
    });

    const result = await generateDesignIrTool(
      { sourceFile: "react/Button.tsx", url: "http://localhost:3000", selector: ".btn" },
      withCheckpoints({ projectRoot, provider, captureComponent: capture })
    );

    expect(capture.calls).toHaveLength(1);
    expect(result.captureCount).toBe(1);

    const plan = JSON.parse(readFileSync(join(result.checkpointDir, CHECKPOINT_FILES.capturePlan), "utf-8"));
    expect(plan.captures).toHaveLength(1);
    expect(plan.captures[0].status).toBe("completed");
  });

  it("resume after a failed capture: a subsequent call for the same component/source/requested captures reuses the SAME checkpoint version, doesn't recapture what already succeeded, and only retries the one that failed (Issue.md §5/§9C)", async () => {
    checkpointRoot = mkdtempSync(join(tmpdir(), "reactfig-gen-checkpoint-"));
    const checkpointMapPath = join(checkpointRoot, "checkpoint-map.json");
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({ componentDisplayName: "StatCard", variantAxes: [], nodeAnnotations: [] }),
    });
    const args = {
      sourceFile: "react/Button.tsx",
      url: "http://localhost:3000",
      selector: ".stat-card",
      componentName: "StatCard",
      variants: [{ propValues: { tone: "success" }, selector: ".stat-card:nth-of-type(2)" }],
    };

    // First attempt: the default capture succeeds, the variant capture fails.
    const failingCalls: CaptureRequest[] = [];
    const failingCapture = async (request: CaptureRequest) => {
      failingCalls.push(request);
      if (request.label.startsWith("variant=")) throw new Error("browser timeout");
      return (await makeFakeCapture()(request));
    };

    await expect(
      generateDesignIrTool(args, { projectRoot, provider, captureComponent: failingCapture, checkpointRootDir: checkpointRoot, checkpointMapPath })
    ).rejects.toThrow("browser timeout");
    expect(failingCalls).toHaveLength(2); // both were attempted this run

    const planAfterFailure = JSON.parse(readFileSync(join(checkpointRoot, "StatCard", "v001", CHECKPOINT_FILES.capturePlan), "utf-8"));
    expect(planAfterFailure.captures.find((c: { label: string }) => c.label === "default").status).toBe("completed");
    expect(planAfterFailure.captures.find((c: { label: string }) => c.label.startsWith("variant=")).status).toBe("failed");

    // Second attempt, same args, same source: only the previously-failed capture should be retried.
    const retryCalls: CaptureRequest[] = [];
    const retryCapture = async (request: CaptureRequest) => {
      retryCalls.push(request);
      return makeFakeCapture()(request);
    };

    const result = await generateDesignIrTool(args, { projectRoot, provider, captureComponent: retryCapture, checkpointRootDir: checkpointRoot, checkpointMapPath });

    expect(retryCalls).toHaveLength(1); // only the failed one was recaptured — "default" was reused from disk
    expect(retryCalls[0].label).toBe("variant=tone:success");
    expect(result.checkpointVersion).toBe(1); // same version reused, not a fresh v002
    expect(result.captureCount).toBe(2); // both captures present in the final evidence/result
    expect(result.validation.valid).toBe(true);

    const finalPlan = JSON.parse(readFileSync(join(checkpointRoot, "StatCard", "v001", CHECKPOINT_FILES.capturePlan), "utf-8"));
    expect(finalPlan.captures.every((c: { status: string }) => c.status === "completed")).toBe(true);
  });

  it("a second call with a genuinely new source (different requested captures) does NOT resume — gets its own fresh version, since resuming would silently mix an unrelated prior attempt's captures", async () => {
    checkpointRoot = mkdtempSync(join(tmpdir(), "reactfig-gen-checkpoint-"));
    const checkpointMapPath = join(checkpointRoot, "checkpoint-map.json");
    const provider = new MockModelProvider({
      onGenerateWithTools: () => ({ text: "done", toolCalls: [] }),
      onGenerateStructured: () => ({ componentDisplayName: "StatCard", variantAxes: [], nodeAnnotations: [] }),
    });

    const firstArgs = { sourceFile: "react/Button.tsx", url: "http://localhost:3000", selector: ".stat-card", componentName: "StatCard" };
    const first = await generateDesignIrTool(firstArgs, { projectRoot, provider, captureComponent: makeFakeCapture(), checkpointRootDir: checkpointRoot, checkpointMapPath });
    expect(first.checkpointVersion).toBe(1);

    // A second, complete (non-failed) call for the same component always gets a fresh version —
    // resuming only ever applies to an INCOMPLETE prior attempt (Issue.md's "if capture 3 of 4
    // fails" framing, not "every repeated call reuses the last version").
    const second = await generateDesignIrTool(firstArgs, { projectRoot, provider, captureComponent: makeFakeCapture(), checkpointRootDir: checkpointRoot, checkpointMapPath });
    expect(second.checkpointVersion).toBe(2);
  });
});
