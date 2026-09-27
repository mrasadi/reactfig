import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import type { DesignDocument } from "@reactfig/core";
import { pack } from "../src/pack.js";
import { unpack } from "../src/unpack.js";

function fixture(name: string): DesignDocument {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/design-ir/${name}.json`, import.meta.url)), "utf-8"));
}
function assetBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/assets/${name}`, import.meta.url))));
}

describe("unpack — happy path", () => {
  it("returns the manifest, document, and embedded asset bytes", async () => {
    const packed = await pack(fixture("avatar"), { assetBytes: { "/avatars/amir.png": assetBytes("amir.png") } });
    const result = await unpack(packed.bytes);
    expect(result.manifest.root.componentId).toBe("comp_avatar");
    expect(result.document.id).toBe("doc_avatar");
    expect(result.assets["asset_0"]).toEqual(assetBytes("amir.png"));
  });

  it("does not include unresolved (non-embedded) assets in the returned assets map", async () => {
    const packed = await pack(fixture("avatar")); // no bytes provided
    const result = await unpack(packed.bytes);
    expect(result.assets).toEqual({});
    expect(result.manifest.assets[0].embedded).toBe(false);
  });
});

describe("unpack — rejects a broken archive with a specific error", () => {
  it("rejects something that isn't a zip at all", async () => {
    await expect(unpack(new Uint8Array([1, 2, 3]))).rejects.toThrow(/not a valid zip archive/);
  });

  it("rejects a zip missing manifest.json", async () => {
    const zip = new JSZip();
    zip.file("ir.json", "{}");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(unpack(bytes)).rejects.toThrow(/missing manifest\.json/);
  });

  it("rejects a zip missing ir.json", async () => {
    const zip = new JSZip();
    zip.file("manifest.json", "{}");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(unpack(bytes)).rejects.toThrow(/missing ir\.json/);
  });

  it("rejects a manifest that fails schema validation", async () => {
    const packed = await pack(fixture("button"));
    const zip = await JSZip.loadAsync(packed.bytes);
    zip.file("manifest.json", JSON.stringify({ garbage: true }));
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(unpack(bytes)).rejects.toThrow(/invalid manifest\.json/);
  });

  it("rejects an ir.json that fails design-ir/v1 validation", async () => {
    const packed = await pack(fixture("button"));
    const zip = await JSZip.loadAsync(packed.bytes);
    zip.file("ir.json", JSON.stringify({ garbage: true }));
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(unpack(bytes)).rejects.toThrow(/invalid ir\.json/);
  });

  it("rejects a version mismatch between manifest and ir.json", async () => {
    const packed = await pack(fixture("button"));
    const zip = await JSZip.loadAsync(packed.bytes);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    manifest.designIrVersion = "design-ir/v2"; // still passes the manifest schema's const check? no — const requires exact "design-ir/v1"
    // Use a manifest that is schema-valid but deliberately mismatched isn't possible since designIrVersion is a const in v1 —
    // this test instead confirms the const constraint itself catches the mismatch at the manifest-validation stage.
    zip.file("manifest.json", JSON.stringify(manifest));
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(unpack(bytes)).rejects.toThrow(/invalid manifest\.json/);
  });

  it("rejects a manifest declaring an embedded asset whose file is actually missing", async () => {
    const packed = await pack(fixture("avatar"), { assetBytes: { "/avatars/amir.png": assetBytes("amir.png") } });
    const zip = await JSZip.loadAsync(packed.bytes);
    zip.remove("assets/asset_0.png");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(unpack(bytes)).rejects.toThrow(/file is missing from the archive/);
  });
});
