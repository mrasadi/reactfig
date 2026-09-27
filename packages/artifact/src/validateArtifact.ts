import JSZip from "jszip";
import { validateDesignIR, type DesignDocument } from "@reactfig/core";
import { validateManifest, type ArtifactManifest } from "./manifest.js";

export interface ArtifactValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * The five checks required for an artifact to be considered valid,
 * collected rather than short-circuited so a caller (e.g. the inspect
 * CLI) can report every problem in one pass instead of fixing them one at
 * a time: (1) manifest schema, (2) Design IR schema, (3) artifact/IR
 * version compatibility, (4) asset reference completeness, (5) package
 * integrity (valid zip, required files present, embedded files actually
 * exist). `unpack()` runs the same checks but throws on the first
 * failure — use that when you just need the parsed result or a hard stop.
 */
export async function checkArtifact(bytes: Uint8Array): Promise<ArtifactValidationResult> {
  const errors: string[] = [];
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (err) {
    return { valid: false, errors: [`not a valid zip archive: ${(err as Error).message}`] };
  }

  const manifestFile = zip.file("manifest.json");
  const irFile = zip.file("ir.json");
  if (!manifestFile) errors.push("missing manifest.json");
  if (!irFile) errors.push("missing ir.json");
  if (errors.length > 0) return { valid: false, errors };

  let manifest: unknown;
  let document: unknown;
  try {
    manifest = JSON.parse(await manifestFile!.async("string"));
  } catch {
    errors.push("manifest.json is not valid JSON");
  }
  try {
    document = JSON.parse(await irFile!.async("string"));
  } catch {
    errors.push("ir.json is not valid JSON");
  }
  if (errors.length > 0) return { valid: false, errors };

  const manifestResult = validateManifest(manifest);
  if (!manifestResult.valid) errors.push(...manifestResult.errors.map((e) => `manifest.json${e.path}: ${e.message}`));

  const irResult = validateDesignIR(document);
  if (!irResult.valid) errors.push(...irResult.errors.map((e) => `ir.json${e.path}: ${e.message}`));

  if (manifestResult.valid && irResult.valid) {
    const m = manifest as ArtifactManifest;
    const d = document as DesignDocument;

    if (m.designIrVersion !== d.version) {
      errors.push(`manifest designIrVersion "${m.designIrVersion}" does not match ir.json version "${d.version}"`);
    }

    const manifestAssetIds = new Set(m.assets.map((a) => a.id));
    for (const asset of d.assets) {
      if (!manifestAssetIds.has(asset.id)) errors.push(`asset "${asset.id}" is referenced in ir.json but has no manifest entry`);
    }

    for (const entry of m.assets) {
      if (entry.embedded && !zip.file(entry.path)) {
        errors.push(`manifest declares asset "${entry.id}" embedded at "${entry.path}" but that file is missing from the archive`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
