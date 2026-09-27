/// <reference types="@figma/plugin-typings" />
import type { RenderContext } from "./types.js";

const PLACEHOLDER_COLOR: RGB = { r: 0.85, g: 0.85, b: 0.85 };

/** Neutral, clearly-a-placeholder fill for a missing or unresolvable asset — never a guess at unrelated content (per the brief's explicit instruction). */
export function placeholderFill(): Paint {
  return { type: "SOLID", color: PLACEHOLDER_COLOR, opacity: 1 };
}

function mapScaleMode(scaleMode: string | undefined): "FILL" | "FIT" | "CROP" | "TILE" {
  switch (scaleMode) {
    case "fit":
      return "FIT";
    case "tile":
      return "TILE";
    case "stretch":
      return "CROP"; // Figma has no literal "stretch" scale mode; CROP is the closest (no aspect-ratio preservation)
    default:
      return "FILL";
  }
}

/**
 * Returns null (never throws) when the asset isn't embedded or is an SVG
 * (createImage only accepts raster PNG/JPEG/GIF bytes — see
 * docs/figma-plugin/feasibility.md). Callers fall back to
 * placeholderFill() and the reason is recorded in ctx.warnings.
 */
export function createImagePaintOrNull(assetId: string, scaleMode: string | undefined, ctx: RenderContext, context: string): Paint | null {
  const bytes = ctx.assets[assetId];
  if (!bytes) {
    ctx.warnings.push(`${context}: asset "${assetId}" is not embedded in this artifact — using a placeholder.`);
    return null;
  }
  const mimeType = ctx.assetMimeTypes[assetId];
  if (mimeType === "image/svg+xml") {
    ctx.warnings.push(`${context}: asset "${assetId}" is an SVG, which cannot be used as a fill paint (only as a standalone node) — using a placeholder.`);
    return null;
  }
  const image = ctx.figmaApi.createImage(bytes);
  return { type: "IMAGE", imageHash: image.hash, scaleMode: mapScaleMode(scaleMode) };
}

/** For an Image IR node whose asset is an SVG — a structurally different Figma representation (a FrameNode of vectors) than a raster fill. Returns null (never throws) when the asset isn't embedded. */
export function createSvgNode(assetId: string, ctx: RenderContext, context: string): FrameNode | null {
  const bytes = ctx.assets[assetId];
  if (!bytes) {
    ctx.warnings.push(`${context}: SVG asset "${assetId}" is not embedded in this artifact — using a placeholder.`);
    return null;
  }
  return ctx.figmaApi.createNodeFromSvg(decodeUtf8(bytes));
}

/**
 * Manual UTF-8 decode rather than relying on the global TextDecoder — the
 * Figma sandbox's exact global surface for standard Web APIs like
 * TextDecoder was not independently verified in this environment (same
 * defensive posture as shared/base64.ts avoiding btoa/atob). This covers
 * the full UTF-8 range, not just ASCII.
 */
function decodeUtf8(bytes: Uint8Array): string {
  let result = "";
  let i = 0;
  while (i < bytes.length) {
    const byte1 = bytes[i++];
    if (byte1 < 0x80) {
      result += String.fromCharCode(byte1);
    } else if (byte1 >= 0xc0 && byte1 < 0xe0 && i < bytes.length) {
      const byte2 = bytes[i++];
      result += String.fromCharCode(((byte1 & 0x1f) << 6) | (byte2 & 0x3f));
    } else if (byte1 >= 0xe0 && byte1 < 0xf0 && i + 1 < bytes.length) {
      const byte2 = bytes[i++];
      const byte3 = bytes[i++];
      result += String.fromCharCode(((byte1 & 0x0f) << 12) | ((byte2 & 0x3f) << 6) | (byte3 & 0x3f));
    } else if (byte1 >= 0xf0 && i + 2 < bytes.length) {
      const byte2 = bytes[i++];
      const byte3 = bytes[i++];
      const byte4 = bytes[i++];
      const codepoint = ((byte1 & 0x07) << 18) | ((byte2 & 0x3f) << 12) | ((byte3 & 0x3f) << 6) | (byte4 & 0x3f);
      result += String.fromCodePoint(codepoint);
    } else {
      result += String.fromCharCode(byte1); // malformed sequence — best-effort, not expected for well-formed SVG assets
    }
  }
  return result;
}
