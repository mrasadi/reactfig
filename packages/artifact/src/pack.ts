import JSZip from "jszip";
import { validateDesignIR, stableStringify, type AssetRef, type DesignDocument } from "@reactfig/core";
import type { ArtifactManifest, ManifestAssetEntry } from "./manifest.js";

export interface PackOptions {
  /**
   * Injectable creation timestamp — defaults to `new Date().toISOString()`.
   * Pass a fixed value for reproducible/diffable output in tests; see
   * docs/adr/0009-artifact-format.md, "Determinism".
   */
  createdAt?: string;
  /**
   * Asset bytes keyed by the AssetRef.path exactly as it appears in
   * `doc.assets` before packing (i.e. whatever the analyzer captured —
   * typically a dev-server-relative URL). Assets without an entry here are
   * still recorded in the manifest with `embedded: false` rather than
   * failing the pack — see "Assets" in ADR 0009.
   */
  assetBytes?: Record<string, Uint8Array>;
}

export interface PackResult {
  bytes: Uint8Array;
  manifest: ArtifactManifest;
}

/**
 * Fixed so zip entry timestamps don't make byte-identical output
 * impossible across separate pack() calls with identical content — see
 * ADR 0009, "Determinism". The exact value is arbitrary; only its
 * fixedness matters.
 */
const FIXED_ZIP_DATE = new Date(Date.UTC(2020, 0, 1));

/**
 * Packs a validated Design IR document (+ optional asset bytes) into a
 * deterministic .rfd archive. Rejects an invalid document up front rather
 * than packaging something the plugin would later refuse — pack() is a
 * second, independent point where design-ir/v1 is checked (the first is
 * wherever the document was generated, e.g. `generateDesignIR`).
 *
 * Asset paths are rewritten from their evidence-captured original
 * location to an artifact-relative path (`assets/<id><ext>`) so the
 * packed `ir.json` is self-contained — a future Figma plugin can resolve
 * every embedded asset from the archive alone, without access to the
 * developer's React repository or dev server.
 */
export async function pack(doc: DesignDocument, options: PackOptions = {}): Promise<PackResult> {
  const validation = validateDesignIR(doc);
  if (!validation.valid) {
    throw new Error(
      `pack: cannot package an invalid design-ir/v1 document: ${validation.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`
    );
  }

  const root = doc.components[0];
  if (!root) {
    throw new Error("pack: document has no components — nothing to package as a root");
  }

  const assetBytes = options.assetBytes ?? {};
  const createdAt = options.createdAt ?? new Date().toISOString();

  const manifestAssets: ManifestAssetEntry[] = [];
  const rewrittenAssets: AssetRef[] = [];
  const zip = new JSZip();

  for (const asset of doc.assets) {
    const bytes = assetBytes[asset.path];
    if (bytes) {
      const artifactPath = `assets/${asset.id}${extensionFor(asset.mimeType)}`;
      zip.file(artifactPath, bytes, { date: FIXED_ZIP_DATE });
      manifestAssets.push({
        id: asset.id,
        path: artifactPath,
        mimeType: asset.mimeType,
        width: asset.width,
        height: asset.height,
        embedded: true,
        sizeBytes: bytes.byteLength,
      });
      rewrittenAssets.push({ ...asset, path: artifactPath });
    } else {
      // Not embedded — recorded honestly rather than silently dropped or faked.
      manifestAssets.push({
        id: asset.id,
        path: asset.path,
        mimeType: asset.mimeType,
        width: asset.width,
        height: asset.height,
        embedded: false,
      });
      rewrittenAssets.push(asset);
    }
  }

  const packedDoc: DesignDocument = { ...doc, assets: rewrittenAssets };

  const manifest: ArtifactManifest = {
    $schema: "https://reactfig.dev/schema/rfd-manifest/v1.json",
    artifactFormat: "reactfig-design-artifact",
    artifactVersion: "v1",
    designIrVersion: doc.version,
    generator: doc.meta.generator,
    createdAt,
    root: { documentId: doc.id, documentName: doc.name, componentId: root.id, componentKind: root.kind },
    componentCount: doc.components.length,
    assets: manifestAssets,
  };

  zip.file("manifest.json", stableStringify(manifest), { date: FIXED_ZIP_DATE });
  zip.file("ir.json", stableStringify(packedDoc), { date: FIXED_ZIP_DATE });

  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: "UNIX", // avoid DOS-vs-UNIX external-attribute differences across machines
   });

  return { bytes, manifest };
}

function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/svg+xml":
      return ".svg";
    case "image/webp":
      return ".webp";
    default:
      return ".bin";
  }
}
