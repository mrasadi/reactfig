import { describe, it, expect } from "vitest";
import { renderNode } from "../../src/code/render/renderNode.js";
import { createFakeFigma } from "../fakeFigma/createFakeFigma.js";
import { ZERO_BOUNDS } from "../../src/code/render/geometry.js";
import type { RenderContext } from "../../src/code/render/types.js";
import type { Node as IRNode } from "@reactfig/core";

function makeCtx(assets: Record<string, Uint8Array> = {}, assetMimeTypes: Record<string, string> = {}) {
  const fake = createFakeFigma();
  const ctx: RenderContext = { figmaApi: fake.figma, componentIndex: new Map(), assets, assetMimeTypes, warnings: [], loadedFonts: new Set() };
  return { ctx, ...fake };
}

describe("renderNode — frame", () => {
  it("creates a frame at a position relative to its parent, with fills/strokes/cornerRadius/layout applied", async () => {
    const { ctx, currentPage } = makeCtx();
    const node: IRNode = {
      type: "frame",
      id: "n1",
      name: "Card",
      bounds: { x: 116, y: 60, width: 200, height: 100 },
      fills: [{ type: "solid", color: { r: 1, g: 1, b: 1, a: 1 } }],
      cornerRadius: 12,
      layout: { mode: "horizontal", gap: 8 },
      children: [],
    };
    const result = (await renderNode(node, { x: 100, y: 50, width: 400, height: 300 }, currentPage as never, ctx)) as unknown as Record<
      string,
      unknown
    >;
    expect(result.type).toBe("FRAME");
    expect(result.name).toBe("Card");
    expect(result.x).toBe(16);
    expect(result.y).toBe(10);
    expect(result.cornerRadius).toBe(12);
    expect(result.layoutMode).toBe("HORIZONTAL");
  });
});

describe("renderNode — text", () => {
  it("loads the font before setting characters, and applies typography", async () => {
    const { ctx, currentPage } = makeCtx();
    const node: IRNode = {
      type: "text",
      id: "n2",
      name: "Label",
      bounds: { x: 24, y: 12, width: 112, height: 24 },
      characters: "Get started",
      typography: { fontFamily: "Inter", fontWeight: 600, fontSize: 16, textAlign: "center" },
      fills: [{ type: "solid", color: { r: 1, g: 1, b: 1, a: 1 } }],
    };
    const result = (await renderNode(node, ZERO_BOUNDS, currentPage as never, ctx)) as unknown as Record<string, unknown>;
    expect(result.characters).toBe("Get started");
    expect(result.fontName).toEqual({ family: "Inter", style: "Semi Bold" });
    expect(result.fontSize).toBe(16);
    expect(result.textAlignHorizontal).toBe("CENTER");
  });

  // Regression test for the "badge/pill text renders pinned to the
  // top-left instead of centered" bug: a text node used to hug both
  // dimensions unconditionally, discarding the box width CENTER alignment
  // needs to have any visible effect at all.
  it("gives center-aligned text a fixed-width box matching its IR bounds, not a hug-width one", async () => {
    const { ctx, currentPage } = makeCtx();
    const node: IRNode = {
      type: "text",
      id: "n2b",
      name: "Badge Text",
      bounds: { x: 0, y: 0, width: 60, height: 20 },
      characters: "completed",
      typography: { fontFamily: "Inter", fontWeight: 700, fontSize: 12, textAlign: "center" },
      fills: [{ type: "solid", color: { r: 1, g: 1, b: 1, a: 1 } }],
    };
    const result = (await renderNode(node, ZERO_BOUNDS, currentPage as never, ctx)) as unknown as Record<string, unknown>;
    expect(result.textAutoResize).toBe("HEIGHT"); // fixed width, not WIDTH_AND_HEIGHT hug
    expect(result.width).toBe(60); // matches the IR's captured box width — what CENTER actually centers within
  });

  it("keeps hug-both-dimensions sizing for left-aligned (default) text — unconstrained labels shouldn't get a forced width", async () => {
    const { ctx, currentPage } = makeCtx();
    const node: IRNode = {
      type: "text",
      id: "n2c",
      name: "Plain label",
      bounds: { x: 0, y: 0, width: 112, height: 24 },
      characters: "Get started",
      typography: { fontFamily: "Inter", fontWeight: 600, fontSize: 16 },
      fills: [{ type: "solid", color: { r: 1, g: 1, b: 1, a: 1 } }],
    };
    const result = (await renderNode(node, ZERO_BOUNDS, currentPage as never, ctx)) as unknown as Record<string, unknown>;
    expect(result.textAutoResize).toBe("WIDTH_AND_HEIGHT");
  });
});

describe("renderNode — shape", () => {
  it("creates a RectangleNode for 'rectangle' and an EllipseNode for 'ellipse'", async () => {
    const { ctx, currentPage } = makeCtx();
    const rectNode: IRNode = { type: "shape", id: "n3", name: "R", bounds: { x: 0, y: 0, width: 10, height: 10 }, shape: "rectangle" };
    const ellipseNode: IRNode = { type: "shape", id: "n4", name: "E", bounds: { x: 0, y: 0, width: 10, height: 10 }, shape: "ellipse" };
    const rect = (await renderNode(rectNode, ZERO_BOUNDS, currentPage as never, ctx)) as unknown as { type: string };
    const ellipse = (await renderNode(ellipseNode, ZERO_BOUNDS, currentPage as never, ctx)) as unknown as { type: string };
    expect(rect.type).toBe("RECTANGLE");
    expect(ellipse.type).toBe("ELLIPSE");
  });
});

describe("renderNode — image", () => {
  it("creates an image-filled rectangle for a raster asset", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { ctx, currentPage, createImageCalls } = makeCtx({ asset_0: bytes }, { asset_0: "image/png" });
    const node: IRNode = { type: "image", id: "n5", name: "Avatar", bounds: { x: 0, y: 0, width: 80, height: 80 }, assetId: "asset_0" };
    const result = (await renderNode(node, ZERO_BOUNDS, currentPage as never, ctx)) as unknown as { type: string; fills: unknown[]; name: string };
    expect(result.type).toBe("RECTANGLE");
    expect(result.fills).toEqual([{ type: "IMAGE", imageHash: "hash-1", scaleMode: "FILL" }]);
    expect(result.name).toBe("Avatar");
    expect(createImageCalls).toEqual([bytes]);
  });

  it("creates a vector FrameNode (via createNodeFromSvg) for an SVG asset, not an image fill", async () => {
    const svgBytes = new TextEncoder().encode("<svg></svg>");
    const { ctx, currentPage, createSvgCalls } = makeCtx({ asset_0: svgBytes }, { asset_0: "image/svg+xml" });
    const node: IRNode = { type: "image", id: "n6", name: "Icon", bounds: { x: 0, y: 0, width: 24, height: 24 }, assetId: "asset_0" };
    const result = (await renderNode(node, ZERO_BOUNDS, currentPage as never, ctx)) as unknown as { type: string };
    expect(result.type).toBe("FRAME");
    expect(createSvgCalls).toEqual(["<svg></svg>"]);
  });
});

describe("renderNode — group", () => {
  it("groups rendered children via figma.group", async () => {
    const { ctx, currentPage } = makeCtx();
    const node: IRNode = {
      type: "group",
      id: "n7",
      name: "Icons",
      bounds: { x: 0, y: 0, width: 40, height: 20 },
      children: [
        { type: "shape", id: "c1", name: "A", bounds: { x: 0, y: 0, width: 20, height: 20 }, shape: "rectangle" },
        { type: "shape", id: "c2", name: "B", bounds: { x: 20, y: 0, width: 20, height: 20 }, shape: "rectangle" },
      ],
    };
    const result = (await renderNode(node, ZERO_BOUNDS, currentPage as never, ctx)) as unknown as { type: string; children: unknown[]; name: string };
    expect(result.type).toBe("GROUP");
    expect(result.children).toHaveLength(2);
    expect(result.name).toBe("Icons");
  });
});

describe("renderNode — instance (cornerRadius rescale fix)", () => {
  // Regression tests for: a component captured with a "fully rounded"
  // corner radius (border-radius: 50%, the standard circular-avatar
  // pattern) rendering as a merely-rounded rectangle — not a circle —
  // whenever it's instanced at a size different from whichever usage
  // happened to get captured.
  function makeMasterComponent(ctx: RenderContext, size: number, cornerRadius: number): unknown {
    const master = ctx.figmaApi.createComponent() as unknown as { resize(w: number, h: number): void; cornerRadius: number };
    master.resize(size, size);
    master.cornerRadius = cornerRadius;
    return master;
  }

  it("rescales a fully-rounded master's cornerRadius to match a larger instance, keeping it circular", async () => {
    const { ctx, currentPage } = makeCtx();
    const master = makeMasterComponent(ctx, 32, 16); // captured at 32×32, border-radius:50% -> 16, correctly circular there
    ctx.componentIndex.set("comp_avatar", master as never);

    const node: IRNode = {
      type: "instance",
      id: "n8",
      name: "Avatar",
      bounds: { x: 0, y: 0, width: 48, height: 48 }, // this usage is 48×48, not 32×32
      componentRef: { kind: "component", componentId: "comp_avatar" },
    };
    const result = (await renderNode(node, ZERO_BOUNDS, currentPage as never, ctx)) as unknown as { cornerRadius: number; width: number; height: number };
    expect(result.width).toBe(48);
    expect(result.cornerRadius).toBe(24); // half of 48 — still a perfect circle, not the stale 16
  });

  it("leaves an ordinary (non-maxed) corner radius untouched at a different instance size — a fixed px card corner shouldn't scale", async () => {
    const { ctx, currentPage } = makeCtx();
    const master = makeMasterComponent(ctx, 200, 8); // an 8px card corner, nowhere near half of 200
    ctx.componentIndex.set("comp_card", master as never);

    const node: IRNode = {
      type: "instance",
      id: "n9",
      name: "Card",
      bounds: { x: 0, y: 0, width: 320, height: 120 },
      componentRef: { kind: "component", componentId: "comp_card" },
    };
    const result = (await renderNode(node, ZERO_BOUNDS, currentPage as never, ctx)) as unknown as { cornerRadius: number };
    expect(result.cornerRadius).toBe(8); // unchanged — this is a fixed measurement, not a shape statement
  });

  it("matches the instance's own size exactly when it equals the master's captured size — no accidental change", async () => {
    const { ctx, currentPage } = makeCtx();
    const master = makeMasterComponent(ctx, 32, 16);
    ctx.componentIndex.set("comp_avatar", master as never);

    const node: IRNode = {
      type: "instance",
      id: "n10",
      name: "Avatar",
      bounds: { x: 0, y: 0, width: 32, height: 32 },
      componentRef: { kind: "component", componentId: "comp_avatar" },
    };
    const result = (await renderNode(node, ZERO_BOUNDS, currentPage as never, ctx)) as unknown as { cornerRadius: number };
    expect(result.cornerRadius).toBe(16);
  });
});

describe("renderNode — instance overrides (Issue.md Fix 2c: per-instance content for repeated template components)", () => {
  it("overrides a nested text node's characters via a flat child-index path, leaving unrelated siblings untouched", async () => {
    const { ctx, currentPage } = makeCtx();

    // Build a StatCard-like master: frame -> [value text, label text].
    const master = ctx.figmaApi.createComponent();
    const valueText = ctx.figmaApi.createText();
    valueText.characters = "12";
    valueText.fontName = { family: "Inter", style: "Bold" };
    master.appendChild(valueText);
    const labelText = ctx.figmaApi.createText();
    labelText.characters = "Sessions this week";
    labelText.fontName = { family: "Inter", style: "Regular" };
    master.appendChild(labelText);
    ctx.componentIndex.set("comp_statcard", master as never);

    const node: IRNode = {
      type: "instance",
      id: "node_instance_3",
      name: "StatCard",
      bounds: { x: 0, y: 0, width: 368, height: 77 },
      componentRef: { kind: "component", componentId: "comp_statcard" },
      overrides: [{ path: [0], characters: "6.8" }],
    };
    const result = (await renderNode(node, ZERO_BOUNDS, currentPage as never, ctx)) as unknown as { children: Array<{ characters?: string }> };

    expect(result.children[0].characters).toBe("6.8"); // overridden value
    expect(result.children[1].characters).toBe("Sessions this week"); // label untouched
  });

  it("overrides fills on a node reached by crossing into a nested instance's own component (e.g. a Badge's tone color nested inside a SessionCard)", async () => {
    const { ctx, currentPage } = makeCtx();

    const badgeMaster = ctx.figmaApi.createComponent();
    const badgeText = ctx.figmaApi.createText();
    badgeText.characters = "completed";
    badgeText.fontName = { family: "Inter", style: "Regular" };
    badgeMaster.appendChild(badgeText);
    ctx.componentIndex.set("comp_badge", badgeMaster as never);

    const sessionCardMaster = ctx.figmaApi.createComponent();
    const badgeInstancePlaceholder = ctx.figmaApi.createComponent(); // stand-in child whose createInstance path we exercise below
    sessionCardMaster.appendChild(badgeInstancePlaceholder);
    ctx.componentIndex.set("comp_sessioncard", sessionCardMaster as never);

    const node: IRNode = {
      type: "instance",
      id: "node_instance_8",
      name: "SessionCard",
      bounds: { x: 0, y: 0, width: 272, height: 173 },
      componentRef: { kind: "component", componentId: "comp_sessioncard" },
    };
    const rendered = (await renderNode(node, ZERO_BOUNDS, currentPage as never, ctx)) as unknown as { children: Array<{ type: string }> };
    // The fake's createInstance clones COMPONENT children as INSTANCE
    // nodes (matching real Figma's nested-instance mirroring) but has no
    // notion of *that* nested instance's own overrides — that only
    // happens when renderInstance itself renders it as a Design-IR
    // `instance` node with `overrides` set, which is the actual pipeline
    // path (a Badge instance is its own IR node, nested inside
    // SessionCard's IR root) exercised by the merge.test.ts coverage of
    // findNodePath crossing into a nested instance. This renderNode-level
    // test instead confirms fills apply correctly at any resolved path,
    // covering the render half of that same mechanism.
    expect(rendered.children[0].type).toBe("INSTANCE");

    const green = { r: 0, g: 0.6, b: 0.3, a: 1 };
    const node2: IRNode = {
      type: "instance",
      id: "node_instance_badge",
      name: "Badge",
      bounds: { x: 0, y: 0, width: 90, height: 28 },
      componentRef: { kind: "component", componentId: "comp_badge" },
      overrides: [{ path: [0], fills: [{ type: "solid", color: green }] }],
    };
    const result = (await renderNode(node2, ZERO_BOUNDS, currentPage as never, ctx)) as unknown as { children: Array<{ fills: unknown[] }> };
    expect(result.children[0].fills).toEqual([{ type: "SOLID", color: { r: 0, g: 0.6, b: 0.3 }, opacity: 1 }]);
  });

  it("warns and skips (without throwing) when an override path doesn't resolve to a real node", async () => {
    const { ctx, currentPage } = makeCtx();
    const master = ctx.figmaApi.createComponent();
    ctx.componentIndex.set("comp_empty", master as never);

    const node: IRNode = {
      type: "instance",
      id: "n_bad",
      name: "Empty",
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      componentRef: { kind: "component", componentId: "comp_empty" },
      overrides: [{ path: [5], characters: "unused" }],
    };
    await expect(renderNode(node, ZERO_BOUNDS, currentPage as never, ctx)).resolves.toBeDefined();
    expect(ctx.warnings.some((w) => w.includes("does not resolve to a node"))).toBe(true);
  });

  it("warns and skips a characters override targeted at a non-text node, instead of throwing", async () => {
    const { ctx, currentPage } = makeCtx();
    const master = ctx.figmaApi.createComponent();
    const childFrame = ctx.figmaApi.createFrame();
    master.appendChild(childFrame);
    ctx.componentIndex.set("comp_wrap", master as never);

    const node: IRNode = {
      type: "instance",
      id: "n_wrong_type",
      name: "Wrap",
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      componentRef: { kind: "component", componentId: "comp_wrap" },
      overrides: [{ path: [0], characters: "nope" }],
    };
    await expect(renderNode(node, ZERO_BOUNDS, currentPage as never, ctx)).resolves.toBeDefined();
    expect(ctx.warnings.some((w) => w.includes('"characters" override skipped'))).toBe(true);
  });
});
