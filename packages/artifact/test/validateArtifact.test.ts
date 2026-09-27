import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import type { DesignDocument } from "@reactfig/core";
import { pack } from "../src/pack.js";
import { checkArtifact } from "../src/validateArtifact.js";

function fixture(name: string): DesignDocument {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/design-ir/${name}.json`, import.meta.url)), "utf-8"));
}

describe("checkArtifact — valid artifacts", () => {
  it("reports valid:true with no errors for a freshly packed artifact", async () => {
    const packed = await pack(fixture("session-card"));
    const result = await checkArtifact(packed.bytes);
    expect(result).toEqual({ valid: true, errors: [] });
  });
});

describe("checkArtifact — collects every problem instead of stopping at the first", () => {
  it("reports a manifest/ir.json asset mismatch (asset referenced in ir.json but absent from manifest)", async () => {
    const packed = await pack(fixture("avatar"));
    const zip = await JSZip.loadAsync(packed.bytes);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    manifest.assets = []; // drop the asset entry the ir.json still references
    zip.file("manifest.json", JSON.stringify(manifest));
    const bytes = await zip.generateAsync({ type: "uint8array" });

    const result = await checkArtifact(bytes);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('asset "asset_0" is referenced in ir.json but has no manifest entry'))).toBe(true);
  });

  it("reports both a missing ir.json AND a missing manifest.json in one pass", async () => {
    const zip = new JSZip();
    zip.file("readme.txt", "not an artifact");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const result = await checkArtifact(bytes);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("missing manifest.json"), expect.stringContaining("missing ir.json")]));
  });

  it("does not throw for a corrupt archive — returns a clean validation failure", async () => {
    const result = await checkArtifact(new Uint8Array([9, 9, 9]));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/not a valid zip archive/);
  });
});
