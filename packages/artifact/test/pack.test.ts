import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import type { DesignDocument } from "@reactfig/core";
import { pack } from "../src/pack.js";

function fixture(name: string): DesignDocument {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/design-ir/${name}.json`, import.meta.url)), "utf-8"));
}
function assetBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/assets/${name}`, import.meta.url))));
}

describe("pack — determinism", () => {
  it("produces byte-identical output for identical input across separate calls", async () => {
    const doc = fixture("button");
    const a = await pack(doc, { createdAt: "2026-01-01T00:00:00.000Z" });
    const b = await pack(doc, { createdAt: "2026-01-01T00:00:00.000Z" });
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  it("defaults createdAt to now but exposes it explicitly, separate from the deterministic payload", async () => {
    const before = Date.now();
    const result = await pack(fixture("button"));
    const parsedTime = Date.parse(result.manifest.createdAt);
    expect(parsedTime).toBeGreaterThanOrEqual(before);
  });

  it("produces byte-identical output regardless of the input document's key insertion order", async () => {
    const doc = fixture("button");
    const reordered: DesignDocument = {
      pages: doc.pages,
      components: doc.components,
      assets: doc.assets,
      meta: doc.meta,
      name: doc.name,
      id: doc.id,
      version: doc.version,
      $schema: doc.$schema,
    };
    const a = await pack(doc, { createdAt: "2026-01-01T00:00:00.000Z" });
    const b = await pack(reordered, { createdAt: "2026-01-01T00:00:00.000Z" });
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });
});

describe("pack — rejects invalid input", () => {
  it("throws for a document that fails design-ir/v1 validation", async () => {
    const doc = fixture("button") as unknown as Record<string, unknown>;
    delete doc.version; // required field
    await expect(pack(doc as unknown as DesignDocument)).rejects.toThrow(/cannot package an invalid design-ir\/v1 document/);
  });

  it("throws for a document with no components", async () => {
    const doc = { ...fixture("avatar"), components: [] };
    await expect(pack(doc)).rejects.toThrow(/no components/);
  });
});

describe("pack — asset embedding", () => {
  it("embeds provided asset bytes and rewrites the ir.json path to be artifact-relative", async () => {
    const doc = fixture("avatar");
    const result = await pack(doc, { assetBytes: { "/avatars/amir.png": assetBytes("amir.png") } });
    expect(result.manifest.assets).toEqual([
      { id: "asset_0", path: "assets/asset_0.png", mimeType: "image/png", width: 256, height: 256, embedded: true, sizeBytes: 68 },
    ]);

    const zip = await JSZip.loadAsync(result.bytes);
    expect(zip.file("assets/asset_0.png")).not.toBeNull();
    const ir = JSON.parse(await zip.file("ir.json")!.async("string"));
    expect(ir.assets[0].path).toBe("assets/asset_0.png"); // not the original dev-server URL
  });

  it("records an unresolved asset honestly (embedded:false) rather than failing the whole pack", async () => {
    const doc = fixture("avatar");
    const result = await pack(doc); // no assetBytes provided
    expect(result.manifest.assets).toEqual([
      { id: "asset_0", path: "/avatars/amir.png", mimeType: "image/png", width: 256, height: 256, embedded: false },
    ]);
    const zip = await JSZip.loadAsync(result.bytes);
    expect(zip.file("assets/asset_0.png")).toBeNull();
  });

  it("a component with no assets produces an empty manifest asset list and no assets/ entries", async () => {
    const result = await pack(fixture("button"));
    expect(result.manifest.assets).toEqual([]);
    const zip = await JSZip.loadAsync(result.bytes);
    expect(Object.keys(zip.files).some((f) => f.startsWith("assets/"))).toBe(false);
  });
});

describe("pack — manifest content", () => {
  it("derives root/component metadata from the document", async () => {
    const result = await pack(fixture("button"));
    expect(result.manifest.root.componentKind).toBe("componentSet");
    expect(result.manifest.root.componentId).toBe("comp_button");
    expect(result.manifest.componentCount).toBe(1);
    expect(result.manifest.designIrVersion).toBe("design-ir/v1");
    expect(result.manifest.artifactFormat).toBe("reactfig-design-artifact");
  });
});
