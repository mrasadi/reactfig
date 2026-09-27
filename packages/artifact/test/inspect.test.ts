import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DesignDocument } from "@reactfig/core";
import { pack } from "../src/pack.js";
import { unpack } from "../src/unpack.js";
import { inspect } from "../src/inspect.js";

function fixture(name: string): DesignDocument {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/design-ir/${name}.json`, import.meta.url)), "utf-8"));
}
function assetBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/assets/${name}`, import.meta.url))));
}

describe("inspect", () => {
  it("summarizes the Button component set: 2 variants, node counts, no assets", async () => {
    const packed = await pack(fixture("button"));
    const unpacked = await unpack(packed.bytes);
    const summary = inspect(unpacked);
    expect(summary.rootComponentKind).toBe("componentSet");
    expect(summary.rootComponentName).toBe("Button");
    expect(summary.componentCount).toBe(1);
    expect(summary.variantCount).toBe(2);
    expect(summary.assetCount).toBe(0);
    expect(summary.embeddedAssetCount).toBe(0);
    // 2 variants, each: 1 frame + 1 text = 2 nodes, plus the page instance (not counted as a component node)
    expect(summary.nodeCount).toBeGreaterThan(0);
  });

  it("summarizes SessionCard: nested instances count as nodes, not expanded further", async () => {
    const packed = await pack(fixture("session-card"));
    const unpacked = await unpack(packed.bytes);
    const summary = inspect(unpacked);
    expect(summary.rootComponentKind).toBe("component");
    expect(summary.rootComponentName).toBe("SessionCard");
    expect(summary.variantCount).toBe(0);
    // root frame + title text + row frame + avatar instance + badge instance = 5, plus the page instance = 6
    expect(summary.nodeCount).toBe(6);
  });

  it("reflects embedded vs. total asset counts distinctly", async () => {
    const packedEmbedded = await pack(fixture("avatar"), { assetBytes: { "/avatars/amir.png": assetBytes("amir.png") } });
    const embeddedSummary = inspect(await unpack(packedEmbedded.bytes));
    expect(embeddedSummary.assetCount).toBe(1);
    expect(embeddedSummary.embeddedAssetCount).toBe(1);

    const packedUnresolved = await pack(fixture("avatar"));
    const unresolvedSummary = inspect(await unpack(packedUnresolved.bytes));
    expect(unresolvedSummary.assetCount).toBe(1);
    expect(unresolvedSummary.embeddedAssetCount).toBe(0);
  });
});
