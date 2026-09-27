import type { ToolDefinition } from "@reactfig/model";
import type { EvidenceStore } from "./evidenceStore.js";

/**
 * One consolidated tool rather than the seven-plus micro-tools the brief
 * sketched (inspect_source, inspect_element, inspect_nested_component,
 * inspect_responsive_capture, inspect_asset, inspect_screenshot,
 * compare_viewports). A `kind` discriminator covers all of them; "compare
 * viewports" specifically needs no dedicated tool at all — the model can
 * call this twice with two `captureLabel`s and compare the results itself.
 * See docs/adr/0008-ai-orchestration.md for the consolidation rationale.
 */
export const GET_EVIDENCE_TOOL: ToolDefinition = {
  name: "get_evidence",
  description:
    "Request additional deterministic evidence beyond what's in the initial bundle. Use this instead of guessing — every kind of evidence below is exact, not visual estimation.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["kind"],
    properties: {
      kind: {
        type: "string",
        enum: ["source", "element", "nested_component", "viewport_capture", "asset", "screenshot"],
        description:
          "source: full AST evidence (props, JSX outline, imports). " +
          "element: one DOM node's full style/bounds detail, given captureLabel+path. " +
          "nested_component: every DOM node owned by a given componentName, across all captures (summary, not full subtrees). " +
          "viewport_capture: one capture's full DOM tree + propValues, given captureLabel — use to compare responsive states or a specific variant. " +
          "asset: metadata for one image/background-image asset, given assetRef (the src/URL). " +
          "screenshot: the crop image for one capture, given captureLabel — only useful if you have vision.",
      },
      captureLabel: { type: "string", description: "Required for element, viewport_capture, screenshot." },
      path: {
        type: "array",
        items: { type: "integer", minimum: 0 },
        description: "Required for element — index path into the capture's dom tree, e.g. [1,0].",
      },
      componentName: { type: "string", description: "Required for nested_component." },
      assetRef: { type: "string", description: "Required for asset — the src/URL to look up." },
      screenshotKind: { type: "string", enum: ["primary", "context"], description: "Optional for screenshot, defaults to primary." },
    },
  },
};

export interface ToolExecutionResult {
  /** Text always accompanies the result, even when an image is also attached, since not every provider/step can use the image. */
  text: string;
  imagePath?: string;
}

export interface GetEvidenceArgs {
  kind: "source" | "element" | "nested_component" | "viewport_capture" | "asset" | "screenshot";
  captureLabel?: string;
  path?: number[];
  componentName?: string;
  assetRef?: string;
  screenshotKind?: "primary" | "context";
}

export function executeGetEvidenceTool(store: EvidenceStore, rawArgs: unknown): ToolExecutionResult {
  const args = rawArgs as GetEvidenceArgs;
  switch (args.kind) {
    case "source":
      return { text: JSON.stringify(store.getSource()) };

    case "element": {
      if (!args.captureLabel || !args.path) return { text: `error: "element" requires captureLabel and path` };
      const el = store.getElementAtPath(args.captureLabel, args.path);
      return el ? { text: JSON.stringify(el) } : { text: `error: no element at path ${JSON.stringify(args.path)} in capture "${args.captureLabel}"` };
    }

    case "nested_component": {
      if (!args.componentName) return { text: `error: "nested_component" requires componentName` };
      return { text: JSON.stringify(store.getNestedComponentSummary(args.componentName)) };
    }

    case "viewport_capture": {
      if (!args.captureLabel) return { text: `error: "viewport_capture" requires captureLabel` };
      const capture = store.getCapture(args.captureLabel);
      return capture ? { text: JSON.stringify(capture) } : { text: `error: no capture labeled "${args.captureLabel}"` };
    }

    case "asset": {
      if (!args.assetRef) return { text: `error: "asset" requires assetRef` };
      const asset = store.getAssetMetadata(args.assetRef);
      return asset ? { text: JSON.stringify(asset) } : { text: `error: no asset found matching "${args.assetRef}"` };
    }

    case "screenshot": {
      if (!args.captureLabel) return { text: `error: "screenshot" requires captureLabel` };
      const ref = store.getScreenshotRef(args.captureLabel, args.screenshotKind ?? "primary");
      if (!ref) return { text: `error: no ${args.screenshotKind ?? "primary"} screenshot for capture "${args.captureLabel}"` };
      return { text: `screenshot at ${ref.path} (${ref.width}x${ref.height})`, imagePath: ref.path };
    }

    default:
      return { text: `error: unknown evidence kind "${(args as { kind: string }).kind}"` };
  }
}
