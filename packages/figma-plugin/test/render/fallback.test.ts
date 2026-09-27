import { describe, it, expect } from "vitest";
import { renderNode } from "../../src/code/render/renderNode.js";
import { createFakeFigma } from "../fakeFigma/createFakeFigma.js";
import { ZERO_BOUNDS } from "../../src/code/render/geometry.js";
import type { RenderContext } from "../../src/code/render/types.js";
import type { Node as IRNode } from "@reactfig/core";

function makeCtx() {
  const fake = createFakeFigma();
  const ctx: RenderContext = { figmaApi: fake.figma, componentIndex: new Map(), assets: {}, assetMimeTypes: {}, warnings: [], loadedFonts: new Set() };
  return { ctx, ...fake };
}

describe("fallback — unresolvable Instance (ADR 0008's external: placeholder componentId)", () => {
  it("renders a labeled placeholder frame and warns, never silently substituting unrelated content", async () => {
    const { ctx, currentPage } = makeCtx();
    const node: IRNode = {
      type: "instance",
      id: "i1",
      name: "Avatar",
      bounds: { x: 0, y: 0, width: 80, height: 80 },
      componentRef: { kind: "component", componentId: "external:Avatar" },
    };
    const result = (await renderNode(node, ZERO_BOUNDS, currentPage as never, ctx)) as unknown as { type: string; name: string; fills: unknown[] };
    expect(result.type).toBe("FRAME");
    expect(result.name).toBe("⚠ Missing component: Avatar");
    expect(result.fills).toEqual([{ type: "SOLID", color: { r: 0.85, g: 0.85, b: 0.85 }, opacity: 1 }]);
    expect(ctx.warnings[0]).toMatch(/Instance "Avatar" references component "external:Avatar", which is not defined/);
  });
});

describe("fallback — asset declared but not embedded", () => {
  it("renders a placeholder rectangle with the original name marked, not unrelated content", async () => {
    const { ctx, currentPage } = makeCtx(); // no assets provided
    const node: IRNode = { type: "image", id: "n1", name: "Hero", bounds: { x: 0, y: 0, width: 100, height: 60 }, assetId: "asset_missing" };
    const result = (await renderNode(node, ZERO_BOUNDS, currentPage as never, ctx)) as unknown as { name: string; fills: unknown[] };
    expect(result.name).toBe("⚠ Missing asset: Hero");
    expect(result.fills).toEqual([{ type: "SOLID", color: { r: 0.85, g: 0.85, b: 0.85 }, opacity: 1 }]);
    expect(ctx.warnings[0]).toMatch(/asset "asset_missing" is not embedded/);
  });
});

describe("fallback — empty Group", () => {
  it("renders an empty frame instead (Figma disallows empty groups) and warns", async () => {
    const { ctx, currentPage } = makeCtx();
    const node: IRNode = { type: "group", id: "g1", name: "Empty", bounds: { x: 0, y: 0, width: 10, height: 10 }, children: [] };
    const result = (await renderNode(node, ZERO_BOUNDS, currentPage as never, ctx)) as unknown as { type: string; name: string };
    expect(result.type).toBe("FRAME");
    expect(result.name).toBe("Empty");
    expect(ctx.warnings[0]).toMatch(/Group "Empty" has no children/);
  });
});
