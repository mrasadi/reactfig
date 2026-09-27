import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mergeDesignDocuments, type DesignDocument } from "@reactfig/core";
import { renderDocument } from "../src/code/render/renderDocument.js";
import { createFakeFigma } from "./fakeFigma/createFakeFigma.js";

function fixture(name: string): DesignDocument {
  const path = fileURLToPath(new URL(`../../artifact/test/fixtures/design-ir/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** A standalone Badge document with center-aligned text — reproduces the reported "badge text top-left instead of centered" scenario as an actual dependency merged into SessionCard, not just a bare text node in isolation. */
function badgeDocument(): DesignDocument {
  return {
    $schema: "https://reactfig.dev/schema/design-ir/v1.json",
    version: "design-ir/v1",
    id: "doc_badge",
    name: "Badge example",
    meta: { generator: "@reactfig/analyzer ai-orchestration@0.1.0", generatedAt: "2026-08-19T12:00:00.000Z" },
    assets: [],
    components: [
      {
        kind: "component",
        id: "comp_badge",
        name: "Badge",
        source: { file: "src/components/Badge.tsx", export: "Badge" },
        root: {
          type: "frame",
          id: "node_badge_root",
          name: "Badge",
          bounds: { x: 0, y: 0, width: 60, height: 20 },
          fills: [{ type: "solid", color: { r: 0.13, g: 0.55, b: 0.13, a: 1 } }],
          cornerRadius: 999,
          children: [
            {
              type: "text",
              id: "node_badge_text",
              name: "Badge Text",
              bounds: { x: 8, y: 4, width: 44, height: 12 },
              characters: "completed",
              typography: { fontFamily: "Inter", fontWeight: 700, fontSize: 12, textAlign: "center" },
              fills: [{ type: "solid", color: { r: 1, g: 1, b: 1, a: 1 } }],
            },
          ],
        },
      },
    ],
    pages: [
      {
        id: "page_examples",
        name: "Examples",
        children: [
          {
            type: "instance",
            id: "node_badge_instance",
            name: "Badge",
            bounds: { x: 0, y: 0, width: 60, height: 20 },
            componentRef: { kind: "component", componentId: "comp_badge" },
          },
        ],
      },
    ],
  } as DesignDocument;
}

describe("end-to-end regression — SessionCard merged with Avatar+Badge, then rendered (the exact reported bug)", () => {
  const merged = mergeDesignDocuments(fixture("session-card"), [fixture("avatar"), badgeDocument()]);

  it("merge resolves both external refs — nothing left unresolved", () => {
    expect(merged.unresolvedExternalRefs).toEqual([]);
  });

  it("rendering the merged document produces zero 'missing component' warnings or placeholder frames", async () => {
    const { figma, currentPage } = createFakeFigma();
    const result = await renderDocument(merged.document, {}, {}, figma);

    expect(result.warnings.filter((w) => w.includes("Missing component"))).toEqual([]);
    expect(result.warnings.filter((w) => w.includes("is not defined"))).toEqual([]);

    function collectNames(node: { name: string; children?: unknown[] }, out: string[]): void {
      out.push(node.name);
      for (const child of (node.children as { name: string; children?: unknown[] }[]) ?? []) collectNames(child, out);
    }
    const allNames: string[] = [];
    for (const child of currentPage.children as { name: string; children?: unknown[] }[]) collectNames(child, allNames);
    expect(allNames.filter((n) => n.startsWith("⚠ Missing component"))).toEqual([]);
  });

  it("the merged Badge component's text renders with a fixed-width, centered box — not hugging/top-left", async () => {
    const { figma, currentPage } = createFakeFigma();
    await renderDocument(merged.document, {}, {}, figma);

    const root = currentPage.children.find((c) => c.name.startsWith("ReactFig:"))!;
    type Fake = { type: string; name: string; children: Fake[]; textAutoResize?: string; width?: number };
    function find(node: Fake, predicate: (n: Fake) => boolean): Fake | undefined {
      if (predicate(node)) return node;
      for (const child of node.children ?? []) {
        const found = find(child, predicate);
        if (found) return found;
      }
      return undefined;
    }
    const badgeComponent = find(root as unknown as Fake, (n) => n.type === "COMPONENT" && n.name === "Badge");
    expect(badgeComponent).toBeDefined();
    const badgeText = find(badgeComponent!, (n) => n.type === "TEXT");
    expect(badgeText).toBeDefined();
    expect(badgeText!.textAutoResize).toBe("HEIGHT"); // fixed width, not hug-both
    expect(badgeText!.width).toBe(44); // matches the IR's captured box width — what CENTER actually centers within
  });
});

/** StatCard's actual CSS pattern: `border: 1px solid gray; border-left: 4px solid green;` — a uniform 1px border plus a distinct 4px left accent. */
function statCardDocument(): DesignDocument {
  return {
    $schema: "https://reactfig.dev/schema/design-ir/v1.json",
    version: "design-ir/v1",
    id: "doc_statcard",
    name: "StatCard example",
    meta: { generator: "@reactfig/analyzer ai-orchestration@0.1.0", generatedAt: "2026-08-19T12:00:00.000Z" },
    assets: [],
    components: [
      {
        kind: "component",
        id: "comp_statcard",
        name: "StatCard",
        source: { file: "src/components/StatCard.tsx", export: "StatCard" },
        root: {
          type: "frame",
          id: "node_statcard_root",
          name: "StatCard",
          bounds: { x: 0, y: 0, width: 140, height: 80 },
          fills: [{ type: "solid", color: { r: 1, g: 1, b: 1, a: 1 } }],
          strokes: [{ color: { r: 34 / 255, g: 139 / 255, b: 34 / 255, a: 1 }, width: 4, style: "solid" }],
          strokeWeights: { top: 1, right: 1, bottom: 1, left: 4 },
          children: [],
        },
      },
    ],
    pages: [
      {
        id: "page_examples",
        name: "Examples",
        children: [
          {
            type: "instance",
            id: "node_statcard_instance",
            name: "StatCard",
            bounds: { x: 0, y: 0, width: 140, height: 80 },
            componentRef: { kind: "component", componentId: "comp_statcard" },
          },
        ],
      },
    ],
  } as DesignDocument;
}

describe("end-to-end regression — StatCard's border-left accent stripe (the exact reported bug)", () => {
  it("renders with per-side stroke weights reaching the actual Figma node — the left accent survives, not silently collapsed to a uniform border", async () => {
    const { figma, currentPage } = createFakeFigma();
    await renderDocument(statCardDocument(), {}, {}, figma);

    const root = currentPage.children.find((c) => c.name.startsWith("ReactFig:"))!;
    type Fake = { type: string; name: string; children: Fake[]; strokeTopWeight?: number; strokeRightWeight?: number; strokeBottomWeight?: number; strokeLeftWeight?: number };
    function find(node: Fake, predicate: (n: Fake) => boolean): Fake | undefined {
      if (predicate(node)) return node;
      for (const child of node.children ?? []) {
        const found = find(child, predicate);
        if (found) return found;
      }
      return undefined;
    }
    const statCard = find(root as unknown as Fake, (n) => n.name === "StatCard" && n.type === "COMPONENT");
    expect(statCard).toBeDefined();
    expect(statCard!.strokeTopWeight).toBe(1);
    expect(statCard!.strokeRightWeight).toBe(1);
    expect(statCard!.strokeBottomWeight).toBe(1);
    expect(statCard!.strokeLeftWeight).toBe(4); // the accent — this is what "border-left not rendered" was losing
  });
});
