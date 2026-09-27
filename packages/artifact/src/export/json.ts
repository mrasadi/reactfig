import { stableStringify, type DesignDocument } from "@reactfig/core";

export interface JsonExportOptions {
  /** Pretty-print with 2-space indentation. Default true — a JSON export is meant to be read/diffed, not just parsed. */
  pretty?: boolean;
}

export interface JsonExportResult {
  json: string;
}

/**
 * Renders the Design IR document itself as canonical JSON. No second
 * schema — the Design IR *is* the JSON representation (see docs section
 * 8); this only chooses a deterministic, human-diffable serialization of
 * it, reusing @reactfig/core's stableStringify (sorted keys) so two
 * generations of an unchanged document produce byte-identical output,
 * same convention as @reactfig/artifact's pack() and the MCP checkpoint
 * layer.
 */
export function renderJson(doc: DesignDocument, options: JsonExportOptions = {}): JsonExportResult {
  const pretty = options.pretty ?? true;
  // stableStringify (sorted keys, 2-space indent) is the project-wide
  // deterministic-JSON convention (see @reactfig/core's stableJson.ts) —
  // reused as-is for the pretty case. The compact case re-parses +
  // re-serializes without indentation; sorted key order survives the
  // round-trip since JSON.parse/stringify preserve string-key insertion
  // order, so both cases stay byte-for-byte comparable modulo whitespace.
  const stable = stableStringify(doc);
  if (pretty) return { json: stable };
  return { json: JSON.stringify(JSON.parse(stable)) };
}
