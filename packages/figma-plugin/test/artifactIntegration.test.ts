import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pack, unpack } from "@reactfig/artifact";
import type { DesignDocument } from "@reactfig/core";
import { renderDocument } from "../src/code/render/renderDocument.js";
import { createFakeFigma } from "./fakeFigma/createFakeFigma.js";

function fixture(name: string): DesignDocument {
  const path = fileURLToPath(new URL(`../../artifact/test/fixtures/design-ir/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8"));
}
function assetBytes(name: string): Uint8Array {
  const path = fileURLToPath(new URL(`../../artifact/test/fixtures/assets/${name}`, import.meta.url));
  return new Uint8Array(readFileSync(path));
}

/**
 * Category B per the brief: .rfd → unpack → renderer input, using the
 * REAL @reactfig/artifact package (no Figma-specific copy of the
 * fixtures — same golden .rfd source as packages/artifact's own tests).
 * Renders through the fake Figma API (category A), so this proves
 * "the real artifact pipeline feeds correctly into the renderer," not
 * "this looks right in real Figma" — see README, "What's tested here."
 */
describe("artifact integration — button.rfd (ComponentSet, 2 variants)", () => {
  it("packs, unpacks, and renders through the full renderer without error", async () => {
    const packed = await pack(fixture("button"), { createdAt: "2026-01-01T00:00:00.000Z" });
    const unpacked = await unpack(packed.bytes);

    const { figma, currentPage } = createFakeFigma();
    const result = await renderDocument(unpacked.document, unpacked.assets, {}, figma);

    expect(result.warnings).toEqual([]);
    const root = currentPage.children.find((c) => c.name === "ReactFig: Button example");
    expect(root).toBeDefined();
    const set = root!.children.find((c) => c.type === "COMPONENT_SET");
    expect(set!.children.map((c) => c.name)).toEqual(["variant=primary, size=large", "variant=secondary, size=medium"]);
  });
});

describe("artifact integration — session-card.rfd (nested instances, CSS Grid fallback)", () => {
  it("renders placeholder instances for the external Avatar/Badge references and warns for each", async () => {
    const packed = await pack(fixture("session-card"), { createdAt: "2026-01-01T00:00:00.000Z" });
    const unpacked = await unpack(packed.bytes);

    const { figma } = createFakeFigma();
    const result = await renderDocument(unpacked.document, unpacked.assets, {}, figma);

    expect(result.warnings.filter((w) => w.includes("external:Avatar"))).toHaveLength(1);
    expect(result.warnings.filter((w) => w.includes("external:Badge"))).toHaveLength(1);
  });
});

describe("artifact integration — avatar.rfd (embedded raster asset)", () => {
  it("embeds the real packed PNG bytes and creates an image fill from them", async () => {
    const doc = fixture("avatar");
    const packed = await pack(doc, { assetBytes: { "/avatars/amir.png": assetBytes("amir.png") }, createdAt: "2026-01-01T00:00:00.000Z" });
    const unpacked = await unpack(packed.bytes);
    expect(Object.keys(unpacked.assets)).toEqual(["asset_0"]);

    const assetMimeTypes = Object.fromEntries(unpacked.manifest.assets.map((a) => [a.id, a.mimeType]));
    const { figma, createImageCalls } = createFakeFigma();
    const result = await renderDocument(unpacked.document, unpacked.assets, assetMimeTypes, figma);

    expect(result.warnings).toEqual([]);
    expect(createImageCalls).toEqual([unpacked.assets["asset_0"]]);
  });

  it("falls back to a placeholder when the asset was never embedded, with a clear warning — never silent", async () => {
    const packed = await pack(fixture("avatar"), { createdAt: "2026-01-01T00:00:00.000Z" }); // no assetBytes
    const unpacked = await unpack(packed.bytes);
    expect(unpacked.assets).toEqual({});

    const { figma } = createFakeFigma();
    const result = await renderDocument(unpacked.document, unpacked.assets, {}, figma);
    expect(result.warnings[0]).toMatch(/asset_0.*is not embedded/);
  });
});

describe("artifact integration — successive imports are placed deterministically, not overlapping or random", () => {
  it("places a second import to the right of the first", async () => {
    const packed = await pack(fixture("button"), { createdAt: "2026-01-01T00:00:00.000Z" });
    const { figma, currentPage } = createFakeFigma();

    const first = await unpack(packed.bytes);
    await renderDocument(first.document, {}, {}, figma);
    const firstRoot = currentPage.children.find((c) => c.name.startsWith("ReactFig:"))!;

    const second = await unpack(packed.bytes);
    await renderDocument(second.document, {}, {}, figma);
    const roots = currentPage.children.filter((c) => c.name.startsWith("ReactFig:"));
    expect(roots).toHaveLength(2);
    expect(roots[1].x).toBeGreaterThan(firstRoot.x + firstRoot.width);
  });
});
