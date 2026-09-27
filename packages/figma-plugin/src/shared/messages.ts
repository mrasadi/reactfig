import type { ArtifactManifest } from "@reactfig/artifact";
import type { DesignDocument } from "@reactfig/core";

/**
 * The Figma-supported messaging mechanism (figma.ui.postMessage /
 * window.onmessage) carries structured-clone-able payloads. Asset bytes
 * are base64-encoded rather than sent as raw Uint8Array — see
 * docs/figma-plugin/feasibility.md, "Binary transfer, UI → sandbox" for
 * why this is a defensive choice, not a confirmed requirement.
 */
export interface EncodedAsset {
  base64: string;
  mimeType: string;
}

export type UiToCodeMessage = {
  type: "import";
  manifest: ArtifactManifest;
  document: DesignDocument;
  assets: Record<string, EncodedAsset>;
};

export type CodeToUiMessage =
  | { type: "progress"; message: string; current: number; total: number }
  | { type: "success"; warnings: string[] }
  | { type: "error"; message: string };
