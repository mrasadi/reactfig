import JSZip from "jszip";
import { validateDesignIR, type DesignDocument } from "@reactfig/core";
import { validateManifest, type ArtifactManifest } from "./manifest.js";

export interface UnpackResult {
  manifest: ArtifactManifest;
  document: DesignDocument;
  /** assetId -> bytes, embedded assets only. */
  assets: Record<string, Uint8Array>;
}

/**
 * Unpacks and fully validates a .rfd archive: manifest schema, Design IR
 * schema, version cross-check, and embedded-asset presence. The plugin (a
 * future consumer of this function) never trusts an artifact it didn't
 * just generate itself — every check here runs regardless of source, and
 * throws with a specific, actionable message rather than a generic
 * parse failure. For a non-throwing variant (e.g. for a CLI that wants to
 * report every problem rather than stop at the first), see
 * `checkArtifact` in `validateArtifact.ts`.
 */
export async function unpack(bytes: Uint8Array): Promise<UnpackResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (err) {
    throw new Error(`unpack: not a valid zip archive: ${(err as Error).message}`);
  }

  const manifestFile = zip.file("manifest.json");
  const irFile = zip.file("ir.json");
  if (!manifestFile) throw new Error("unpack: archive is missing manifest.json");
  if (!irFile) throw new Error("unpack: archive is missing ir.json");

  const manifest = JSON.parse(await manifestFile.async("string")) as unknown;
  const manifestResult = validateManifest(manifest);
  if (!manifestResult.valid) {
    throw new Error(`unpack: invalid manifest.json: ${manifestResult.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
  }

  const document = JSON.parse(await irFile.async("string")) as unknown;
  const irResult = validateDesignIR(document);
  if (!irResult.valid) {
    throw new Error(`unpack: invalid ir.json: ${irResult.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
  }

  const typedManifest = manifest as ArtifactManifest;
  const typedDocument = document as DesignDocument;

  if (typedManifest.designIrVersion !== typedDocument.version) {
    throw new Error(
      `unpack: manifest designIrVersion "${typedManifest.designIrVersion}" does not match ir.json version "${typedDocument.version}"`
    );
  }

  const assets: Record<string, Uint8Array> = {};
  for (const entry of typedManifest.assets) {
    if (!entry.embedded) continue;
    const file = zip.file(entry.path);
    if (!file) {
      throw new Error(`unpack: manifest declares asset "${entry.id}" embedded at "${entry.path}" but that file is missing from the archive`);
    }
    assets[entry.id] = await file.async("uint8array");
  }

  return { manifest: typedManifest, document: typedDocument, assets };
}
