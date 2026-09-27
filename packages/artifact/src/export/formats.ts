/**
 * Output Intent — the set of output formats a developer can request,
 * either as a persisted Interactive Capture selection/collection default
 * (see @reactfig/mcp's collection/types.ts) or as an explicit argument to
 * export_design_output. `.rfd` remains the backward-compatible default
 * everywhere the pipeline previously assumed RFD-only output (see
 * docs/adr/0027-output-intent-and-source-less-generation.md).
 */
export type OutputFormat = "rfd" | "json" | "svg" | "html";

export const OUTPUT_FORMATS: readonly OutputFormat[] = ["rfd", "json", "svg", "html"];

export const DEFAULT_OUTPUT_FORMAT: OutputFormat = "rfd";

export function isOutputFormat(value: unknown): value is OutputFormat {
  return typeof value === "string" && (OUTPUT_FORMATS as readonly string[]).includes(value);
}

/** File extension (without the leading dot) a given format is conventionally written with. */
export function extensionForFormat(format: OutputFormat): string {
  switch (format) {
    case "rfd":
      return "rfd";
    case "json":
      return "json";
    case "svg":
      return "svg";
    case "html":
      return "html";
  }
}

export function mimeTypeForFormat(format: OutputFormat): string {
  switch (format) {
    case "rfd":
      return "application/zip";
    case "json":
      return "application/json";
    case "svg":
      return "image/svg+xml";
    case "html":
      return "text/html";
  }
}
