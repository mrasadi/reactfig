import { describe, it, expect } from "vitest";
import { buildComponents } from "../../src/code/render/components.js";
import { renderNode } from "../../src/code/render/renderNode.js";
import { createFakeFigma } from "../fakeFigma/createFakeFigma.js";
import { ZERO_BOUNDS } from "../../src/code/render/geometry.js";
import type { RenderContext } from "../../src/code/render/types.js";
import type { DesignDocument, Node as IRNode } from "@reactfig/core";

function makeCtx() {
  const fake = createFakeFigma();
  const ctx: RenderContext = { figmaApi: fake.figma, componentIndex: new Map(), assets: {}, assetMimeTypes: {}, warnings: [], loadedFonts: new Set() };
  return { ctx, ...fake };
}

const buttonDocument: DesignDocument = {
  $schema: "https://reactfig.dev/schema/design-ir/v1.json",
  version: "design-ir/v1",
  id: "doc",
  name: "Button",
  meta: { generator: "test", generatedAt: "2026-01-01T00:00:00.000Z" },
  assets: [],
  components: [
    {
      kind: "componentSet",
      id: "comp_button",
      name: "Button",
      variantProperties: [{ name: "variant", values: ["primary", "secondary"] }],
      properties: [{ name: "disabled", type: "boolean", defaultValue: false }],
      variants: [
        {
          id: "v1",
          propertyValues: { variant: "primary" },
          root: { type: "frame", id: "r1", name: "Button", bounds: { x: 0, y: 0, width: 160, height: 48 }, children: [] },
        },
        {
          id: "v2",
          propertyValues: { variant: "secondary" },
          root: { type: "frame", id: "r2", name: "Button", bounds: { x: 0, y: 0, width: 140, height: 40 }, children: [] },
        },
      ],
    },
  ],
  pages: [{ id: "page", name: "Examples", children: [] }],
};

describe("buildComponents — ComponentSet + variants", () => {
  it("builds one ComponentNode per variant, named per Figma's Property=Value convention, then combines them", async () => {
    const { ctx, currentPage } = makeCtx();
    await buildComponents(buttonDocument, ctx, currentPage as never);

    const set = currentPage.children.find((c) => c.type === "COMPONENT_SET");
    expect(set).toBeDefined();
    expect(set!.name).toBe("Button");
    expect(set!.children.map((c) => c.name)).toEqual(["variant=primary", "variant=secondary"]);
  });

  it("applies non-variant component properties (boolean) to the ComponentSet", async () => {
    const { ctx, currentPage } = makeCtx();
    await buildComponents(buttonDocument, ctx, currentPage as never);
    const set = currentPage.children.find((c) => c.type === "COMPONENT_SET")!;
    expect(set.componentProperties).toEqual([{ name: "disabled", type: "BOOLEAN", defaultValue: false }]);
  });

  it("warns and skips an instanceSwap property rather than fabricating a default", async () => {
    const { ctx, currentPage } = makeCtx();
    const doc: DesignDocument = {
      ...buttonDocument,
      components: [
        {
          kind: "component",
          id: "comp_x",
          name: "X",
          properties: [{ name: "icon", type: "instanceSwap" }],
          root: { type: "frame", id: "r", name: "X", bounds: { x: 0, y: 0, width: 10, height: 10 }, children: [] },
        },
      ],
    };
    await buildComponents(doc, ctx, currentPage as never);
    expect(ctx.warnings[0]).toMatch(/instanceSwap.*skipped/);
    const comp = currentPage.children.find((c) => c.type === "COMPONENT")!;
    expect(comp.componentProperties).toEqual([]);
  });

  it("populates componentIndex keyed by componentSetId:variantId, usable to resolve an Instance", async () => {
    const { ctx, currentPage } = makeCtx();
    await buildComponents(buttonDocument, ctx, currentPage as never);
    expect(ctx.componentIndex.has("comp_button:v1")).toBe(true);
    expect(ctx.componentIndex.has("comp_button:v2")).toBe(true);

    const instanceNode: IRNode = {
      type: "instance",
      id: "i1",
      name: "Button",
      bounds: { x: 0, y: 0, width: 160, height: 48 },
      componentRef: { kind: "variant", componentSetId: "comp_button", variantId: "v1" },
    };
    const rendered = (await renderNode(instanceNode, ZERO_BOUNDS, currentPage as never, ctx)) as unknown as {
      type: string;
      mainComponent: { name: string };
    };
    expect(rendered.type).toBe("INSTANCE");
    expect(rendered.mainComponent.name).toBe("variant=primary");
  });
});

describe("buildComponents — plain ComponentDef (no variants)", () => {
  it("builds a single ComponentNode and indexes it by componentId", async () => {
    const { ctx, currentPage } = makeCtx();
    const doc: DesignDocument = {
      ...buttonDocument,
      components: [
        {
          kind: "component",
          id: "comp_avatar",
          name: "Avatar",
          root: { type: "image", id: "r", name: "Avatar", bounds: { x: 0, y: 0, width: 80, height: 80 }, assetId: "missing" },
        },
      ],
    };
    await buildComponents(doc, ctx, currentPage as never);
    expect(ctx.componentIndex.has("comp_avatar")).toBe(true);
    const comp = ctx.componentIndex.get("comp_avatar")!;
    expect(comp.width).toBe(80);
    expect(comp.height).toBe(80);
  });
});

describe(
  "buildComponents — forward references between sibling components " +
    "(real reported bug: merged SessionCard's own root instantiates Avatar/Badge/Button, " +
    "which mergeDesignDocuments always places AFTER the primary in document.components)",
  () => {
    // Exactly SessionCard@merge's shape: the FIRST component in the array
    // (comp_session_card) has a root that directly instantiates a SECOND
    // component (comp_avatar) appearing LATER in the same array — the
    // order mergeDesignDocuments always produces (primary first,
    // dependencies appended after). Before the fix, buildComponents
    // created-and-immediately-populated one component at a time, so
    // comp_session_card's own instance of comp_avatar rendered before
    // comp_avatar existed in ctx.componentIndex at all.
    const mergedLikeDocument: DesignDocument = {
      ...buttonDocument,
      components: [
        {
          kind: "component",
          id: "comp_primary",
          name: "Primary",
          root: {
            type: "frame",
            id: "primary_root",
            name: "Primary",
            bounds: { x: 0, y: 0, width: 200, height: 100 },
            children: [
              {
                type: "instance",
                id: "primary_root_child_instance",
                name: "Dependency",
                bounds: { x: 0, y: 0, width: 48, height: 48 },
                componentRef: { kind: "component", componentId: "comp_dependency" },
              },
            ],
          },
        },
        {
          kind: "component",
          id: "comp_dependency",
          name: "Dependency",
          root: { type: "image", id: "dep_root", name: "Dependency", bounds: { x: 0, y: 0, width: 48, height: 48 }, assetId: "missing" },
        },
      ],
    };

    it("resolves the forward reference with no warning, and the instance's mainComponent is the real dependency node", async () => {
      const { ctx, currentPage } = makeCtx();
      await buildComponents(mergedLikeDocument, ctx, currentPage as never);

      expect(ctx.warnings.some((w) => w.includes("is not defined in this artifact"))).toBe(false);

      const dependencyComponentNode = ctx.componentIndex.get("comp_dependency");
      expect(dependencyComponentNode).toBeDefined();

      const primaryComponentNode = ctx.componentIndex.get("comp_primary")!;
      const instanceNode = primaryComponentNode.children.find((c) => c.type === "INSTANCE") as unknown as { mainComponent: unknown } | undefined;
      expect(instanceNode).toBeDefined();
      expect(instanceNode!.mainComponent).toBe(dependencyComponentNode);
    });

    it("still resolves correctly regardless of which order the two components appear in (order-independence, not just this one direction)", async () => {
      const { ctx, currentPage } = makeCtx();
      const reversed: DesignDocument = { ...mergedLikeDocument, components: [...mergedLikeDocument.components].reverse() };
      await buildComponents(reversed, ctx, currentPage as never);
      expect(ctx.warnings.some((w) => w.includes("is not defined in this artifact"))).toBe(false);
    });
  }
);

describe("buildComponents — circular instance references (A instantiates B, B instantiates A back — e.g. a recursive TreeNode/Accordion pattern)", () => {
  const circularDocument: DesignDocument = {
    ...buttonDocument,
    components: [
      {
        kind: "component",
        id: "comp_a",
        name: "A",
        root: {
          type: "frame",
          id: "a_root",
          name: "A",
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          children: [
            { type: "instance", id: "a_root_child", name: "B", bounds: { x: 0, y: 0, width: 48, height: 48 }, componentRef: { kind: "component", componentId: "comp_b" } },
          ],
        },
      },
      {
        kind: "component",
        id: "comp_b",
        name: "B",
        root: {
          type: "frame",
          id: "b_root",
          name: "B",
          bounds: { x: 0, y: 0, width: 48, height: 48 },
          children: [
            { type: "instance", id: "b_root_child", name: "A", bounds: { x: 0, y: 0, width: 20, height: 20 }, componentRef: { kind: "component", componentId: "comp_a" } },
          ],
        },
      },
    ],
  };

  it("doesn't hang, still populates both components (each resolvable, no 'not defined' warning), and surfaces a clear warning naming the cycle instead of failing silently", async () => {
    const { ctx, currentPage } = makeCtx();
    await buildComponents(circularDocument, ctx, currentPage as never);

    expect(ctx.warnings.some((w) => w.includes("is not defined in this artifact"))).toBe(false);
    expect(ctx.componentIndex.get("comp_a")).toBeDefined();
    expect(ctx.componentIndex.get("comp_b")).toBeDefined();

    expect(ctx.warnings.some((w) => w.includes("circular instance reference"))).toBe(true);
  });
});
