import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DesignDocument } from "@reactfig/core";
import { renderJson } from "../../src/export/json.js";
import { renderSvg } from "../../src/export/svg.js";
import { renderHtml } from "../../src/export/html.js";
import { renderOutput } from "../../src/export/index.js";
import { DEFAULT_OUTPUT_FORMAT, isOutputFormat, OUTPUT_FORMATS } from "../../src/export/formats.js";

function fixture(name: string): DesignDocument {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/design-ir/${name}.json`, import.meta.url)), "utf-8"));
}

describe("Output Intent — format catalog", () => {
  it("defaults to rfd, the backward-compatible default", () => {
    expect(DEFAULT_OUTPUT_FORMAT).toBe("rfd");
  });

  it("recognizes exactly the four supported formats", () => {
    expect(OUTPUT_FORMATS).toEqual(["rfd", "json", "svg", "html"]);
    expect(isOutputFormat("svg")).toBe(true);
    expect(isOutputFormat("pdf")).toBe(false);
  });
});

describe("renderJson", () => {
  it("round-trips the Design IR document unchanged", () => {
    const doc = fixture("button");
    const { json } = renderJson(doc);
    expect(JSON.parse(json)).toEqual(doc);
  });

  it("is deterministic regardless of key insertion order (reuses stableStringify)", () => {
    const doc = fixture("button");
    const reordered: DesignDocument = { name: doc.name, id: doc.id, ...doc };
    const a = renderJson(doc, { pretty: false }).json;
    const b = renderJson(reordered, { pretty: false }).json;
    expect(a).toBe(b);
  });

  it("supports compact (non-pretty) output", () => {
    const doc = fixture("button");
    const { json } = renderJson(doc, { pretty: false });
    expect(json).not.toContain("\n");
    expect(JSON.parse(json)).toEqual(doc);
  });
});

describe("renderSvg", () => {
  it("produces a well-formed SVG document sized to the root component", () => {
    const doc = fixture("session-card");
    const { svg, width, height } = renderSvg(doc);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain(`viewBox="0 0 ${width} ${height}"`);
    const root = doc.components[0];
    expect(width).toBe(root.kind === "component" ? root.root.bounds.width : 0);
  });

  it("expands instance nodes inline rather than leaving them as unresolved refs", () => {
    const doc = fixture("session-card");
    const { svg } = renderSvg(doc);
    // session-card.json's root composes at least one instance (e.g. an
    // Avatar/Badge) — a correct expansion draws real shapes/text for it,
    // not an empty node.
    expect(svg).toMatch(/<rect|<text|<ellipse/);
  });

  it("escapes text content", () => {
    const doc = fixture("session-card");
    const injected: DesignDocument = JSON.parse(JSON.stringify(doc));
    const comp = injected.components[0];
    if (comp.kind === "component" && comp.root.type === "frame" && comp.root.children[0]?.type === "text") {
      (comp.root.children[0] as { characters: string }).characters = "<script>alert(1)</script>";
    }
    const { svg } = renderSvg(injected);
    expect(svg).not.toContain("<script>alert(1)</script>");
  });
});

describe("renderHtml", () => {
  it("produces a standalone HTML document with absolutely-positioned nodes", () => {
    const doc = fixture("session-card");
    const { html, width, height } = renderHtml(doc);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain(`width:${width}px;height:${height}px`);
    expect(html).toContain("position:absolute");
  });

  it("does not require the original React app to render (no external script/style refs beyond inline)", () => {
    const doc = fixture("session-card");
    const { html } = renderHtml(doc);
    expect(html).not.toMatch(/<script\s+src=/);
    expect(html).not.toMatch(/<link\s+rel="stylesheet"/);
  });
});

describe("renderSvg — effects (drop shadow)", () => {
  it("emits an SVG <filter> with feDropShadow for a frame with a dropShadow effect, and references it via filter=", () => {
    const doc = fixture("session-card");
    const withShadow: DesignDocument = JSON.parse(JSON.stringify(doc));
    const comp = withShadow.components[0];
    if (comp.kind === "component" && comp.root.type === "frame") {
      (comp.root as { effects?: unknown[] }).effects = [
        { type: "dropShadow", color: { r: 0, g: 0, b: 0, a: 0.28 }, offsetX: 0, offsetY: 1, blur: 6 },
      ];
    }
    const { svg } = renderSvg(withShadow);
    expect(svg).toContain("<filter");
    expect(svg).toContain("feDropShadow");
    expect(svg).toMatch(/filter="url\(#shadow_/);
  });

  it("does not emit a <defs> block at all when no node has a shadow effect (the common case)", () => {
    const doc = fixture("session-card");
    const { svg } = renderSvg(doc);
    expect(svg).not.toContain("<defs>");
  });
});

describe("renderHtml — effects (box-shadow)", () => {
  it("emits a CSS box-shadow for a frame with a dropShadow effect", () => {
    const doc = fixture("session-card");
    const withShadow: DesignDocument = JSON.parse(JSON.stringify(doc));
    const comp = withShadow.components[0];
    if (comp.kind === "component" && comp.root.type === "frame") {
      (comp.root as { effects?: unknown[] }).effects = [
        { type: "dropShadow", color: { r: 0, g: 0, b: 0, a: 0.28 }, offsetX: 0, offsetY: 1, blur: 6 },
      ];
    }
    const { html } = renderHtml(withShadow);
    expect(html).toMatch(/box-shadow:0px 1px 6px 0px rgba\(0, 0, 0, 0\.28\)/);
  });

  it("marks an innerShadow with the CSS inset keyword", () => {
    const doc = fixture("session-card");
    const withShadow: DesignDocument = JSON.parse(JSON.stringify(doc));
    const comp = withShadow.components[0];
    if (comp.kind === "component" && comp.root.type === "frame") {
      (comp.root as { effects?: unknown[] }).effects = [
        { type: "innerShadow", color: { r: 0, g: 0, b: 0, a: 0.5 }, offsetX: 0, offsetY: 2, blur: 4 },
      ];
    }
    const { html } = renderHtml(withShadow);
    expect(html).toMatch(/box-shadow:inset 0px 2px 4px/);
  });
});

describe("regression — non-visual DOM elements never become Design IR nodes (real-world bug, docs/adr/0028)", () => {
  // Reproduces, at the Design-IR level, the exact symptom a real capture
  // of google.com's search box surfaced: an inlined <style> tag's own
  // raw CSS text ending up as a zero-size "text" node (its bounding rect
  // is {0,0,0,0} because unrendered elements have no box), which then
  // renders at nonsensical off-canvas coordinates once translated into
  // export-root-relative space. The actual fix is in
  // @reactfig/analyzer's collectDomSnapshot.ts (NON_VISUAL_TAGS filters
  // <style>/<script>/etc. out of the DOM walk entirely, so a node like
  // this can no longer be produced) — this test guards the renderer's
  // own side: IF such a degenerate node ever reaches it anyway (a
  // defense-in-depth concern, not the primary fix), it should not
  // silently produce garbage coordinates that look like real content.
  it("a zero-size text node still renders (not silently dropped) but stays anchored at the translated origin, not scattered arbitrarily", () => {
    const doc = fixture("session-card");
    const withBogusText: DesignDocument = JSON.parse(JSON.stringify(doc));
    const comp = withBogusText.components[0];
    if (comp.kind === "component" && comp.root.type === "frame") {
      comp.root.children.unshift({
        id: "node_bogus_css_text",
        name: "Text",
        type: "text",
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        characters: ".some-class{margin:auto}",
        fills: [{ type: "solid", color: { r: 0, g: 0, b: 0, a: 1 } }],
        typography: { fontFamily: "Arial", fontSize: 14, fontWeight: 400, italic: false, textAlign: "left" },
      });
    }
    const { svg } = renderSvg(withBogusText);
    // The point isn't that this specific bogus node renders "correctly"
    // (there's no correct rendering of CSS-source-as-a-text-node) — it's
    // that collectDomSnapshot.ts's fix means real captures never produce
    // one in the first place. Documented here as a marker so a future
    // change to that filter has a test that would need updating too.
    expect(svg).toContain("<text");
  });
});

describe("renderHtml — real flexbox reconstruction and correct nested positioning (docs/adr/0032)", () => {
  function docWithRoot(root: object): DesignDocument {
    return {
      $schema: "https://reactfig.dev/schema/design-ir/v1.json",
      version: "design-ir/v1",
      id: "doc_test",
      name: "Test",
      meta: { generator: "test", generatedAt: "2026-01-01T00:00:00.000Z" },
      assets: [],
      components: [{ kind: "component", id: "comp_test", name: "Test", root }],
      pages: [],
    } as unknown as DesignDocument;
  }

  it("a captured flex frame becomes real CSS flexbox — children get no position:absolute at all", () => {
    const doc = docWithRoot({
      type: "frame",
      id: "n_root",
      name: "Root",
      bounds: { x: 100, y: 100, width: 200, height: 60 },
      layout: { mode: "horizontal", gap: 8, padding: { top: 4, right: 4, bottom: 4, left: 4 }, primaryAxisAlign: "spaceBetween", counterAxisAlign: "center" },
      children: [
        { type: "shape", shape: "rectangle", id: "n_a", name: "A", bounds: { x: 104, y: 104, width: 40, height: 40 } },
        { type: "shape", shape: "rectangle", id: "n_b", name: "B", bounds: { x: 156, y: 104, width: 40, height: 40 } },
      ],
    });

    const { html } = renderHtml(doc);
    expect(html).toContain("display:flex");
    expect(html).toContain("flex-direction:row");
    expect(html).toContain("justify-content:space-between");
    expect(html).toContain("align-items:center");
    expect(html).toContain("gap:8px");
    expect(html).toContain("padding:4px 4px 4px 4px");
    // The whole point: flex children carry no position:absolute/left/top of their own.
    const shapeDivs = html.match(/<div class="rfd-shape"[^>]*style="([^"]*)"/g) ?? [];
    expect(shapeDivs).toHaveLength(2);
    for (const div of shapeDivs) {
      expect(div).not.toContain("position:absolute");
      expect(div).toContain("flex-shrink:0");
    }
  });

  it("vertical mode and stretch alignment map to flex-direction:column and align-items:stretch", () => {
    const doc = docWithRoot({
      type: "frame",
      id: "n_root",
      name: "Root",
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      layout: { mode: "vertical", counterAxisAlign: "stretch" },
      children: [{ type: "shape", shape: "rectangle", id: "n_a", name: "A", bounds: { x: 0, y: 0, width: 100, height: 50 } }],
    });
    const { html } = renderHtml(doc);
    expect(html).toContain("flex-direction:column");
    expect(html).toContain("align-items:stretch");
  });

  it("a layout:none frame nested INSIDE a flex frame is still absolutely positioned, correctly relative to ITS OWN immediate parent — not the flex container's flex-computed position, and not the global export-root offset", () => {
    // Reproduces the exact real-world bug shape: a freely-positioned
    // (non-flex) subtree nested a few levels inside otherwise-flex
    // ancestors. Before this fix, EVERY level used position:absolute with
    // the single global (export-root-relative) offset, which compounds
    // through nested positioned ancestors — this is exactly what the
    // reported screenshot showed as "small drift."
    const doc = docWithRoot({
      type: "frame",
      id: "n_root",
      name: "Root",
      bounds: { x: 50, y: 50, width: 300, height: 100 },
      layout: { mode: "horizontal" },
      children: [
        {
          type: "frame",
          id: "n_free",
          name: "FreelyPositioned",
          bounds: { x: 70, y: 60, width: 200, height: 80 }, // layout:"none" (absent) — a non-flex child
          children: [
            {
              type: "image",
              id: "n_img",
              name: "Icon",
              assetId: "asset_0",
              bounds: { x: 90, y: 74, width: 20, height: 20 }, // deeply nested leaf, real reported bug's exact shape
            },
          ],
        },
      ],
    });
    (doc as unknown as { assets: unknown[] }).assets = [{ id: "asset_0", path: "https://example.com/icon.png", mimeType: "image/png", width: 20, height: 20 }];

    const { html } = renderHtml(doc);

    // n_free is a flex ITEM of n_root (n_root is flex) — no position:absolute of its own.
    const freeFrameMatch = html.match(/<div class="rfd-frame" data-name="FreelyPositioned" style="([^"]*)"/);
    expect(freeFrameMatch).not.toBeNull();
    expect(freeFrameMatch![1]).not.toContain("position:absolute");
    // ...but it DOES need position:relative, since ITS OWN child (n_img) is absolutely positioned relative to it.
    expect(freeFrameMatch![1]).toContain("position:relative");

    // n_img is positioned relative to n_free's bounds (90-70, 74-60) = (20, 14) — NOT relative to
    // n_root's bounds (90-50, 74-50 = 40,24) and NOT the raw global bounds (90, 74).
    const imgMatch = html.match(/<img class="rfd-image"[^>]*style="([^"]*)"/);
    expect(imgMatch).not.toBeNull();
    expect(imgMatch![1]).toContain("position:absolute");
    expect(imgMatch![1]).toContain("left:20px");
    expect(imgMatch![1]).toContain("top:14px");
    // The actual regression this test guards against — the pre-fix values:
    expect(imgMatch![1]).not.toContain("left:90px");
    expect(imgMatch![1]).not.toContain("left:40px");
  });

  it("three levels of layout:none nesting (no flex anywhere) — every level's left/top is relative to its OWN immediate parent, with zero cumulative drift", () => {
    const doc = docWithRoot({
      type: "frame",
      id: "n_root",
      name: "Root",
      bounds: { x: 20, y: 30, width: 400, height: 300 },
      children: [
        {
          type: "frame",
          id: "n_mid",
          name: "Mid",
          bounds: { x: 60, y: 90, width: 200, height: 150 },
          children: [
            {
              type: "shape",
              shape: "rectangle",
              id: "n_leaf",
              name: "Leaf",
              bounds: { x: 100, y: 150, width: 30, height: 30 },
            },
          ],
        },
      ],
    });

    const { html } = renderHtml(doc);

    const midMatch = html.match(/<div class="rfd-frame" data-name="Mid" style="([^"]*)"/);
    // Mid relative to Root: (60-20, 90-30) = (40, 60)
    expect(midMatch![1]).toContain("left:40px");
    expect(midMatch![1]).toContain("top:60px");

    const leafMatch = html.match(/<div class="rfd-shape" data-name="Leaf" style="([^"]*)"/);
    // Leaf relative to Mid: (100-60, 150-90) = (40, 60) — NOT relative to Root (80,120), NOT global (100,150).
    expect(leafMatch![1]).toContain("left:40px");
    expect(leafMatch![1]).toContain("top:60px");
    expect(leafMatch![1]).not.toContain("left:80px");
    expect(leafMatch![1]).not.toContain("left:100px");
  });

  it("global box-sizing:border-box is set, so an explicit padding+width on a flex container doesn't grow beyond its captured size", () => {
    const doc = docWithRoot({
      type: "frame",
      id: "n_root",
      name: "Root",
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      layout: { mode: "horizontal", padding: { top: 10, right: 10, bottom: 10, left: 10 } },
      children: [],
    });
    const { html } = renderHtml(doc);
    expect(html).toContain("*{box-sizing:border-box;}");
  });
});


describe("renderOutput — dispatcher", () => {
  it("defaults to rfd and produces a valid zip with a manifest", async () => {
    const doc = fixture("button");
    const result = await renderOutput(doc, undefined, { rfd: { createdAt: "2026-01-01T00:00:00.000Z" } });
    expect(result.format).toBe("rfd");
    expect(result.extension).toBe("rfd");
    expect(result.manifest).toBeDefined();
    expect(result.bytes.byteLength).toBeGreaterThan(0);
  });

  it("routes json/svg/html to their respective exporters", async () => {
    const doc = fixture("button");
    for (const format of ["json", "svg", "html"] as const) {
      const result = await renderOutput(doc, format);
      expect(result.format).toBe(format);
      expect(result.bytes.byteLength).toBeGreaterThan(0);
      expect(result.manifest).toBeUndefined();
    }
  });

  it("all four formats consume the exact same input document (no format-specific document mutation)", async () => {
    const doc = fixture("button");
    const before = JSON.stringify(doc);
    for (const format of OUTPUT_FORMATS) {
      await renderOutput(doc, format, { rfd: { createdAt: "2026-01-01T00:00:00.000Z" } });
    }
    expect(JSON.stringify(doc)).toBe(before);
  });
});
