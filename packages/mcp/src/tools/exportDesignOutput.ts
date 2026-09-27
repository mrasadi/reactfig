import { resolve, isAbsolute, dirname } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { renderOutput, extensionForFormat, DEFAULT_OUTPUT_FORMAT, type ArtifactManifest, type OutputFormat, type SvgExportOptions, type HtmlExportOptions } from "@reactfig/artifact";
import type { DesignDocument } from "@reactfig/core";
import { exportDesignArtifactTool, type ExportDesignArtifactContext } from "./exportDesignArtifact.js";

export interface ExportDesignOutputArgs {
  document: DesignDocument;
  /**
   * Which output to produce (docs/architecture.md's Output Intent
   * section). Defaults to "rfd" — the same backward-compatible default
   * export_design_artifact always assumed, so an existing prompt that
   * never mentions a format keeps getting exactly what it got before.
   */
  format?: OutputFormat;
  /** Where to write the file — relative to projectRoot, or absolute. Defaults to `design/<document.name>.<extension for format>`. */
  outputPath?: string;
  /** Only consulted when format is "rfd" — see export_design_artifact's own `fetchAssets`. */
  fetchAssets?: boolean;
  svg?: SvgExportOptions;
  html?: HtmlExportOptions;
  projectRoot?: string;
}

export interface ExportDesignOutputResult {
  path: string;
  format: OutputFormat;
  /** Present only for format "rfd". */
  manifest?: ArtifactManifest;
  warnings: string[];
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned : "design";
}

function defaultOutputPath(document: DesignDocument, format: OutputFormat): string {
  return `design/${sanitizeFileName(document.name)}.${extensionForFormat(format)}`;
}

/**
 * The general "produce a requested output" tool (Output Intent, docs
 * section 6: "Design IR -> Output selection -> Renderer/Exporter").
 * format "rfd" delegates to the existing, unmodified
 * exportDesignArtifactTool — same asset-fetch behavior, same warnings,
 * same .rfd bytes — so export_design_artifact and every existing prompt/
 * MCP client that calls it keep working completely unchanged (docs
 * section 5). json/svg/html go through @reactfig/artifact's new
 * exporters instead, consuming the exact same Design IR.
 */
export async function exportDesignOutputTool(
  args: ExportDesignOutputArgs,
  ctx: ExportDesignArtifactContext
): Promise<ExportDesignOutputResult> {
  const format = args.format ?? DEFAULT_OUTPUT_FORMAT;

  if (format === "rfd") {
    const result = await exportDesignArtifactTool(
      { document: args.document, outputPath: args.outputPath, fetchAssets: args.fetchAssets },
      ctx
    );
    return { path: result.path, format, manifest: result.manifest, warnings: result.warnings };
  }

  const rendered = await renderOutput(args.document, format, { svg: args.svg, html: args.html });
  const requestedPath = args.outputPath ?? defaultOutputPath(args.document, format);
  const outputPath = isAbsolute(requestedPath) ? requestedPath : resolve(ctx.projectRoot, requestedPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, rendered.bytes);

  return { path: outputPath, format, warnings: [] };
}
