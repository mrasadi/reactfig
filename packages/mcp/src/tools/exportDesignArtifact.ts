import { resolve, isAbsolute, dirname } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { pack, type ArtifactManifest } from "@reactfig/artifact";
import { findUnresolvedExternalRefs, type DesignDocument } from "@reactfig/core";

export interface ExportDesignArtifactArgs {
  document: DesignDocument;
  /**
   * Where to write the .rfd file — relative to projectRoot, or absolute.
   * Optional: defaults to `design/<document.name>.rfd` under the project
   * root (Phase 8) — a developer exporting "AuthPage" from
   * `my-react-app` gets `my-react-app/design/AuthPage.rfd` without having
   * to specify a path at all.
   */
  outputPath?: string;
  /** Attempt to fetch http(s) asset references automatically before packing. Default true. */
  fetchAssets?: boolean;
  /** Overrides the server's default project root for this call only — see packages/mcp/src/projectRoot.ts. Consumed by the server dispatch layer (src/server.ts), not read here; present on this type for documentation/schema purposes. */
  projectRoot?: string;
}

export interface ExportDesignArtifactContext {
  projectRoot: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for deterministic manifest.createdAt in tests; defaults to the current time (see @reactfig/artifact's pack()). */
  now?: () => string;
}

export interface ExportDesignArtifactResult {
  path: string;
  manifest: ArtifactManifest;
  /** Non-fatal problems — e.g. an asset URL that failed to fetch. The artifact is still produced, with that asset recorded as unembedded (see @reactfig/artifact's own honest-degradation policy). */
  warnings: string[];
}

/** `"Auth / Page 2!"` -> `"Auth_Page_2"` — safe as a filename on every common filesystem. */
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned : "design";
}

function defaultOutputPath(document: DesignDocument): string {
  return `design/${sanitizeFileName(document.name)}.rfd`;
}

/**
 * The "expose artifact generation" tool: packages an already-validated
 * Design IR document (typically generate_design_ir's output, though any
 * valid document works) into a portable .rfd. All packaging logic lives
 * in @reactfig/artifact's pack() — this function's only job is resolving
 * asset bytes (best-effort HTTP fetch, since evidence-captured asset
 * paths are typically dev-server-relative URLs) and writing the result to
 * disk, which @reactfig/artifact deliberately does not do itself (see
 * docs/adr/0009-artifact-format.md, "Assets" — fetching is an
 * orchestration-level concern kept out of the packaging layer).
 */
/**
 * Decodes a `data:` URI directly into bytes — no network fetch needed,
 * since the bytes are already fully inline (the common producer is
 * @reactfig/analyzer's svgMarkupToDataUri for a captured inline `<svg>`
 * icon, docs/adr/0030, but this handles any data: URI generically).
 * Returns null for a malformed one (missing comma separator) rather than
 * throwing — treated the same as any other unembeddable asset: a
 * warning, not a failed export.
 */
function decodeDataUri(path: string): Uint8Array | null {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(path);
  if (!match) return null;
  const isBase64 = Boolean(match[2]);
  const payload = match[3];
  return isBase64 ? new Uint8Array(Buffer.from(payload, "base64")) : new Uint8Array(Buffer.from(decodeURIComponent(payload), "utf-8"));
}

export async function exportDesignArtifactTool(
  args: ExportDesignArtifactArgs,
  ctx: ExportDesignArtifactContext
): Promise<ExportDesignArtifactResult> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const warnings: string[] = [];
  const assetBytes: Record<string, Uint8Array> = {};

  // Surfaced here, before packing, rather than left to be discovered as a
  // placeholder box after Figma import: a document can reach export having
  // skipped merge_design_ir_documents entirely, or having merged the wrong
  // dependency, and design-ir/v1 doesn't reject that at validation time
  // (ADR 0008 — componentId has no referential-integrity check). This is a
  // warning, not a thrown error, for the same reason pack() itself treats a
  // missing asset as non-fatal: a partially-resolved artifact is still more
  // useful to the caller than no artifact at all.
  for (const ref of findUnresolvedExternalRefs(args.document)) {
    warnings.push(
      `unresolved nested component ref "${ref}": no matching component in this document — instance will render as a placeholder in Figma. Generate a Design IR for it and pass it to merge_design_ir_documents before export.`
    );
  }

  const fetchAssets = args.fetchAssets ?? true;
  if (fetchAssets) {
    for (const asset of args.document.assets) {
      if (asset.path.startsWith("data:")) {
        // Already fully inline — nothing to fetch, just decode (docs/adr/0030).
        const decoded = decodeDataUri(asset.path);
        if (decoded) {
          assetBytes[asset.path] = decoded;
        } else {
          warnings.push(`asset "${asset.id}": malformed data: URI, left unembedded`);
        }
        continue;
      }
      if (!/^https?:\/\//.test(asset.path)) {
        // Not a fetchable URL — left unresolved, same as pack()'s own policy
        // for anything without provided bytes. Previously silent; now
        // warned, since evidence capture (interpretDomSnapshot.ts) always
        // records the browser-resolved `img.src`/background-image URL (or,
        // for an inline <svg> icon, a data: URI handled above already) —
        // anything else here is most likely a capture bug.
        warnings.push(`asset "${asset.id}" (${asset.path}): not an http(s) URL, left unembedded`);
        continue;
      }
      try {
        const res = await fetchImpl(asset.path);
        if (!res.ok) {
          warnings.push(`asset "${asset.id}" (${asset.path}): fetch returned ${res.status}, left unembedded`);
          continue;
        }
        assetBytes[asset.path] = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        warnings.push(`asset "${asset.id}" (${asset.path}): fetch failed (${(err as Error).message}), left unembedded`);
      }
    }
  }

  const packed = await pack(args.document, { assetBytes, createdAt: ctx.now?.() });

  const requestedPath = args.outputPath ?? defaultOutputPath(args.document);
  const outputPath = isAbsolute(requestedPath) ? requestedPath : resolve(ctx.projectRoot, requestedPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, packed.bytes);

  return { path: outputPath, manifest: packed.manifest, warnings };
}