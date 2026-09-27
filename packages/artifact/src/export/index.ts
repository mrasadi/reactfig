import type { DesignDocument } from "@reactfig/core";
import { pack, type PackOptions } from "../pack.js";
import type { ArtifactManifest } from "../manifest.js";
import { renderJson, type JsonExportOptions } from "./json.js";
import { renderSvg, type SvgExportOptions } from "./svg.js";
import { renderHtml, type HtmlExportOptions } from "./html.js";
import { extensionForFormat, mimeTypeForFormat, type OutputFormat, DEFAULT_OUTPUT_FORMAT } from "./formats.js";

export { DEFAULT_OUTPUT_FORMAT, OUTPUT_FORMATS, isOutputFormat, extensionForFormat, mimeTypeForFormat, type OutputFormat } from "./formats.js";
export { renderJson, type JsonExportOptions, type JsonExportResult } from "./json.js";
export { renderSvg, type SvgExportOptions, type SvgExportResult } from "./svg.js";
export { renderHtml, type HtmlExportOptions, type HtmlExportResult } from "./html.js";
export { resolveRoot, type ResolvedNode } from "./resolveTree.js";

export interface RenderOutputOptions {
  /** Only consulted for format "rfd" — see pack()'s own PackOptions. */
  rfd?: PackOptions;
  json?: JsonExportOptions;
  svg?: SvgExportOptions;
  html?: HtmlExportOptions;
}

export interface RenderOutputResult {
  format: OutputFormat;
  bytes: Uint8Array;
  mimeType: string;
  /** File extension without the leading dot, e.g. "rfd", "json". */
  extension: string;
  /** Present only for format "rfd" — the .rfd artifact manifest pack() produced. */
  manifest?: ArtifactManifest;
}

const encoder = new TextEncoder();

/**
 * The single entry point every output-format request eventually goes
 * through — Output Intent (docs section 6): "Design IR -> Output
 * selection -> Renderer/Exporter". `.rfd` continues to go through the
 * existing, unmodified pack() (see docs/adr/0027); json/svg/html are new
 * exporters added alongside it, all consuming the same DesignDocument, no
 * parallel representations (docs section 6).
 */
export async function renderOutput(
  doc: DesignDocument,
  format: OutputFormat = DEFAULT_OUTPUT_FORMAT,
  options: RenderOutputOptions = {}
): Promise<RenderOutputResult> {
  switch (format) {
    case "rfd": {
      const packed = await pack(doc, options.rfd);
      return { format, bytes: packed.bytes, mimeType: mimeTypeForFormat(format), extension: extensionForFormat(format), manifest: packed.manifest };
    }
    case "json": {
      const { json } = renderJson(doc, options.json);
      return { format, bytes: encoder.encode(json), mimeType: mimeTypeForFormat(format), extension: extensionForFormat(format) };
    }
    case "svg": {
      const { svg } = renderSvg(doc, options.svg);
      return { format, bytes: encoder.encode(svg), mimeType: mimeTypeForFormat(format), extension: extensionForFormat(format) };
    }
    case "html": {
      const { html } = renderHtml(doc, options.html);
      return { format, bytes: encoder.encode(html), mimeType: mimeTypeForFormat(format), extension: extensionForFormat(format) };
    }
  }
}
