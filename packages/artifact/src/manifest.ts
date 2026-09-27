import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "./schema/rfd-manifest.v1.schema.json" with { type: "json" };

/**
 * The manifest is artifact-level metadata — it exists alongside ir.json,
 * never inside it. Some fields (createdAt, generator) duplicate/derive
 * from ir.json's own `meta`, kept here too so an artifact can be
 * identified (version, root, asset embedding status) without parsing the
 * full Design IR document. `assets[].embedded` is the field that can't
 * live in ir.json at all — design-ir/v1's AssetRef schema is
 * additionalProperties:false and intentionally doesn't know about
 * artifact packaging (see docs/adr/0009-artifact-format.md).
 */
export interface ManifestAssetEntry {
  id: string;
  /** Path within the .rfd archive, e.g. "assets/asset_0.png" — matches the corresponding AssetRef.path in the packed ir.json exactly when embedded. */
  path: string;
  mimeType: string;
  width?: number;
  height?: number;
  /** False when the artifact was packed without bytes for this asset — see pack.ts's asset-resolution behavior. */
  embedded: boolean;
  sizeBytes?: number;
}

export interface ArtifactManifest {
  $schema: "https://reactfig.dev/schema/rfd-manifest/v1.json";
  artifactFormat: "reactfig-design-artifact";
  artifactVersion: "v1";
  designIrVersion: "design-ir/v1";
  generator: string;
  /** ISO 8601. Explicit and separate from the deterministic design payload — see ADR 0009, "Determinism". */
  createdAt: string;
  root: {
    documentId: string;
    documentName: string;
    componentId: string;
    componentKind: "component" | "componentSet";
  };
  componentCount: number;
  assets: ManifestAssetEntry[];
  compatibility?: {
    minPluginVersion?: string;
  };
}

export interface ManifestValidationError {
  path: string;
  message: string;
}

export interface ManifestValidationResult {
  valid: boolean;
  errors: ManifestValidationError[];
}

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
const validateFn = ajv.compile(schema);

export function validateManifest(value: unknown): ManifestValidationResult {
  const valid = validateFn(value);
  return { valid: !!valid, errors: toErrors(validateFn.errors) };
}

function toErrors(errors: ErrorObject[] | null | undefined): ManifestValidationError[] {
  if (!errors) return [];
  return errors.map((e) => ({ path: e.instancePath || "/", message: e.message ?? "invalid" }));
}
