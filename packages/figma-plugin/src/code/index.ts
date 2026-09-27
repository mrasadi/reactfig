/// <reference types="@figma/plugin-typings" />
import type { UiToCodeMessage, CodeToUiMessage } from "../shared/messages.js";
import { base64ToBytes } from "../shared/base64.js";
import { renderDocument } from "./render/renderDocument.js";

function post(message: CodeToUiMessage): void {
  figma.ui.postMessage(message);
}

figma.showUI(__html__, { width: 340, height: 480 });

figma.ui.onmessage = async (message: UiToCodeMessage) => {
  if (message.type !== "import") return;

  try {
    const assets: Record<string, Uint8Array> = {};
    const assetMimeTypes: Record<string, string> = {};
    for (const [assetId, encoded] of Object.entries(message.assets)) {
      assets[assetId] = base64ToBytes(encoded.base64);
      assetMimeTypes[assetId] = encoded.mimeType;
    }

    const result = await renderDocument(message.document, assets, assetMimeTypes, figma, (text, current, total) =>
      post({ type: "progress", message: text, current, total })
    );

    post({ type: "success", warnings: result.warnings });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
