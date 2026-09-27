import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateDesignIR } from "@reactfig/core";
import { buildDesignIR } from "../../src/ai/buildDesignIR.js";
import { buildComponentEvidence } from "../../src/buildComponentEvidence.js";
import { inspectComponentSource } from "../../src/ast/inspectComponentSource.js";
import { interpretDomSnapshot } from "../../src/evidence/interpretDomSnapshot.js";
import type { RawDomSnapshot } from "../../src/browser/rawTypes.js";
import type { RenderCapture } from "../../src/evidence/types.js";
import type { ComponentInterpretation } from "../../src/ai/types.js";

function fixturePath(rel: string): string {
  return fileURLToPath(new URL(`../fixtures/${rel}`, import.meta.url));
}
function loadRaw(name: string): RawDomSnapshot {
  return JSON.parse(readFileSync(fixturePath(`raw-snapshots/${name}.json`), "utf-8"));
}
function toCapture(label: string, raw: RawDomSnapshot, propValues?: Record<string, unknown>, interactionState?: RenderCapture["interactionState"]): RenderCapture {
  return {
    label,
    viewport: { width: 1440, height: 900 },
    propValues,
    interactionState,
    dom: interpretDomSnapshot(raw),
    screenshot: null,
    contextScreenshot: null,
    capturedUrl: "http://localhost:3000",
    capturedAt: "2026-08-19T12:00:00.000Z",
  };
}

describe("buildDesignIR — Button (evidence-backed variants)", () => {
  const source = inspectComponentSource(fixturePath("react/Button.tsx"));
  const captures = [
    toCapture("default", loadRaw("button-default"), { variant: "primary", size: "medium" }),
    toCapture("variant=secondary,size=large", loadRaw("button-secondary-large"), { variant: "secondary", size: "large" }),
  ];
  const evidence = buildComponentEvidence({ componentName: "Button", source, captures, analyzerVersion: "test" });

  it("builds a ComponentSet with one variant per captured combination", () => {
    const interpretation: ComponentInterpretation = {
      componentDisplayName: "Button",
      variantAxes: [{ propName: "variant", confirmedValues: ["primary", "secondary"], rationale: "both captured" }],
      nodeAnnotations: [],
    };
    const doc = buildDesignIR(evidence, interpretation);
    const component = doc.components[0];
    expect(component.kind).toBe("componentSet");
    if (component.kind === "componentSet") {
      expect(component.variants).toHaveLength(2);
      expect(component.variantProperties).toEqual([{ name: "variant", values: ["primary", "secondary"] }]);
    }
  });

  it("does NOT fabricate a variant for an axis value with no supporting capture", () => {
    // "size" has literalValues [medium, large] in source, but only two captures exist and
    // each pairs a specific variant+size — confirm the axis on "size" alone still only
    // produces variants for combinations actually captured, never an invented third one.
    const interpretation: ComponentInterpretation = {
      componentDisplayName: "Button",
      variantAxes: [
        { propName: "variant", confirmedValues: ["primary", "secondary"], rationale: "both captured" },
        { propName: "size", confirmedValues: ["medium", "large"], rationale: "both captured" },
      ],
      nodeAnnotations: [],
    };
    const doc = buildDesignIR(evidence, interpretation);
    const component = doc.components[0];
    expect(component.kind).toBe("componentSet");
    if (component.kind === "componentSet") {
      // exactly the 2 combinations that were actually captured — not a fabricated
      // primary/large or secondary/medium cross-product entry.
      expect(component.variants).toHaveLength(2);
      const combos = component.variants.map((v) => v.propertyValues);
      expect(combos).toContainEqual({ variant: "primary", size: "medium" });
      expect(combos).toContainEqual({ variant: "secondary", size: "large" });
    }
  });

  it("falls back to a plain ComponentDef when no variant axis is confirmed", () => {
    const interpretation: ComponentInterpretation = { componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] };
    const doc = buildDesignIR(evidence, interpretation);
    expect(doc.components[0].kind).toBe("component");
  });

  it("pulls geometry, color, and typography directly from evidence, not from the interpretation", () => {
    const interpretation: ComponentInterpretation = { componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] };
    const doc = buildDesignIR(evidence, interpretation);
    const component = doc.components[0];
    if (component.kind !== "component") throw new Error("expected component");
    const root = component.root;
    if (root.type !== "frame") throw new Error("expected frame root");
    expect(root.bounds).toEqual({ x: 40, y: 40, width: 160, height: 48 });
    expect(root.fills?.[0]).toMatchObject({ type: "solid" });
    expect(root.layout).toMatchObject({ mode: "horizontal", gap: 8 });
    const label = root.children[0];
    if (label.type !== "text") throw new Error("expected text child");
    expect(label.characters).toBe("Get started");
    expect(label.typography.fontSize).toBe(16);
  });

  it("translates box-shadow (already present in the button-default fixture: 'rgba(0, 0, 0, 0.15) 0px 1px 2px 0px') into a real Effect, not silently dropping it", () => {
    const interpretation: ComponentInterpretation = { componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] };
    const doc = buildDesignIR(evidence, interpretation);
    const component = doc.components[0];
    if (component.kind !== "component") throw new Error("expected component");
    const root = component.root;
    if (root.type !== "frame") throw new Error("expected frame root");
    expect(root.effects).toEqual([{ type: "dropShadow", color: { r: 0, g: 0, b: 0, a: 0.15 }, offsetX: 0, offsetY: 1, blur: 2, spread: 0 }]);
  });

  it("translates filter: blur() and backdrop-filter: blur() into layerBlur/backgroundBlur Effects alongside any box-shadow (Issue.md follow-up — filter/backdrop-filter previously weren't captured from the DOM at all, so blur was invisible end-to-end regardless of what a component actually used)", () => {
    const raw = loadRaw("button-default");
    const withBlur: RawDomSnapshot = { ...raw, computedStyle: { ...raw.computedStyle, filter: "blur(4px)", "backdrop-filter": "blur(12px)" } };
    const blurredCaptures = [toCapture("default", withBlur, { variant: "primary", size: "medium" })];
    const blurredEvidence = buildComponentEvidence({ componentName: "Button", source, captures: blurredCaptures, analyzerVersion: "test" });

    const interpretation: ComponentInterpretation = { componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] };
    const doc = buildDesignIR(blurredEvidence, interpretation);
    const component = doc.components[0];
    if (component.kind !== "component") throw new Error("expected component");
    const root = component.root;
    if (root.type !== "frame") throw new Error("expected frame root");
    // Box-shadow's dropShadow (already in this fixture) survives alongside
    // the two new blur effects — this doesn't replace existing effect
    // mapping, it adds to it.
    expect(root.effects).toEqual([
      { type: "dropShadow", color: { r: 0, g: 0, b: 0, a: 0.15 }, offsetX: 0, offsetY: 1, blur: 2, spread: 0 },
      { type: "layerBlur", radius: 4 },
      { type: "backgroundBlur", radius: 12 },
    ]);
  });

  it("produces a document that passes @reactfig/core's validator", () => {
    const interpretation: ComponentInterpretation = {
      componentDisplayName: "Button",
      variantAxes: [{ propName: "variant", confirmedValues: ["primary", "secondary"], rationale: "both captured" }],
      nodeAnnotations: [],
    };
    const doc = buildDesignIR(evidence, interpretation);
    const result = validateDesignIR(doc);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe("buildDesignIR — SessionCard (nested component collapsing, CSS Grid fallback)", () => {
  const source = inspectComponentSource(fixturePath("react/SessionCard.tsx"));
  const captures = [toCapture("default", loadRaw("session-card"))];
  const evidence = buildComponentEvidence({ componentName: "SessionCard", source, captures, analyzerVersion: "test" });
  const interpretation: ComponentInterpretation = { componentDisplayName: "SessionCard", variantAxes: [], nodeAnnotations: [] };
  const doc = buildDesignIR(evidence, interpretation);

  it("collapses the Avatar and Badge subtrees into Instance nodes, deterministically, with no AI annotation needed", () => {
    const component = doc.components[0];
    if (component.kind !== "component") throw new Error("expected component");
    const cardRoot = component.root;
    if (cardRoot.type !== "frame") throw new Error("expected frame root");
    const row = cardRoot.children[1];
    if (row.type !== "frame") throw new Error("expected frame row");
    const [avatarInstance, badgeInstance] = row.children;
    expect(avatarInstance.type).toBe("instance");
    expect(badgeInstance.type).toBe("instance");
    if (avatarInstance.type === "instance") expect(avatarInstance.componentRef).toEqual({ kind: "component", componentId: "external:Avatar" });
    if (badgeInstance.type === "instance") expect(badgeInstance.componentRef).toEqual({ kind: "component", componentId: "external:Badge" });
  });

  it("attaches the Badge instance's own directly-observed fill and text as instance-level overrides, instead of silently discarding them at the nested-component boundary (real reported failure: every SessionCard's Badge looks identical in Figma)", () => {
    const component = doc.components[0];
    if (component.kind !== "component") throw new Error("expected component");
    const cardRoot = component.root;
    if (cardRoot.type !== "frame") throw new Error("expected frame root");
    const row = cardRoot.children[1];
    if (row.type !== "frame") throw new Error("expected frame row");
    const [, badgeInstance] = row.children;
    if (badgeInstance.type !== "instance") throw new Error("expected instance");

    // The fixture's Badge is `<span class="badge badge-success">completed</span>`
    // — a leaf that is both its own styled box and its own text run, i.e. the
    // "pill" shape mapFrameNode synthesizes a text child for. The override at
    // path [] carries the badge's own observed background fill (its own root);
    // the override at path [0] carries its own text — both captured from THIS
    // render, not from Badge's separately-generated checkpoint.
    expect(badgeInstance.overrides).toEqual([
      { path: [], fills: [{ type: "solid", color: { r: 20 / 255, g: 168 / 255, b: 100 / 255, a: 1 } }] },
      { path: [0], characters: "completed" },
    ]);
  });

  it("does not attach a fill/text override to the Avatar instance (an <img> root) — that dependency's per-instance photo swap is buildInstanceOverridesFromPerInstanceData's job at merge time, not evidence-capture time", () => {
    const component = doc.components[0];
    if (component.kind !== "component") throw new Error("expected component");
    const cardRoot = component.root;
    if (cardRoot.type !== "frame") throw new Error("expected frame root");
    const row = cardRoot.children[1];
    if (row.type !== "frame") throw new Error("expected frame row");
    const [avatarInstance] = row.children;
    if (avatarInstance.type !== "instance") throw new Error("expected instance");
    expect(avatarInstance.overrides).toBeUndefined();
  });

  it("falls back to layout.mode='none' with absolute bounds for the CSS Grid row, per ADR 0002", () => {
    const component = doc.components[0];
    if (component.kind !== "component") throw new Error("expected component");
    const cardRoot = component.root;
    if (cardRoot.type !== "frame") throw new Error("expected frame root");
    const row = cardRoot.children[1];
    if (row.type !== "frame") throw new Error("expected frame row");
    expect(row.layout).toEqual({ mode: "none" });
    // children keep their own absolute bounds — reconstructable without a semantic Grid node.
    expect(row.children[0].bounds).toEqual({ x: 16, y: 60, width: 80, height: 80 });
  });

  it("registers a directly-rendered <img> as an asset and references it by id, not by inlining the URL", () => {
    // A capture whose ROOT is itself the image (i.e. no nested-instance boundary to collapse
    // through first) — this is what a standalone Avatar analysis would look like.
    const avatarRaw = {
      tag: "img",
      attributes: { className: "avatar", src: "/avatars/amir.png", alt: "Amir Hosseini" },
      textContent: null,
      rect: { x: 0, y: 0, width: 80, height: 80 },
      computedStyle: { display: "block", "border-radius": "40px" },
      naturalWidth: 256,
      naturalHeight: 256,
      componentPath: ["Avatar"],
      children: [],
    };
    const source = inspectComponentSource(fixturePath("react/Avatar.tsx"));
    const capture = toCapture("default", avatarRaw as unknown as RawDomSnapshot);
    const avatarEvidence = buildComponentEvidence({ componentName: "Avatar", source, captures: [capture], analyzerVersion: "test" });
    const doc = buildDesignIR(avatarEvidence, { componentDisplayName: "Avatar", variantAxes: [], nodeAnnotations: [] });

    expect(doc.assets).toHaveLength(1);
    expect(doc.assets[0]).toMatchObject({ path: "/avatars/amir.png", width: 256, height: 256 });
    const component = doc.components[0];
    if (component.kind !== "component") throw new Error("expected component");
    expect(component.root.type).toBe("image");
    if (component.root.type === "image") expect(component.root.assetId).toBe(doc.assets[0].id);
  });

  it("registers an inline <svg> icon (docs/adr/0030) as an image asset the same way as an <img> — no vector node type needed", () => {
    const iconRaw = {
      tag: "svg",
      attributes: { className: "search-icon" },
      textContent: null,
      rect: { x: 0, y: 0, width: 24, height: 24 },
      computedStyle: { display: "block" },
      naturalWidth: null,
      naturalHeight: null,
      svgMarkup: '<svg viewBox="0 0 24 24"><path fill="rgb(95, 99, 104)" d="M15.5 14h-.79l-.28-.27A6.5 6.5 0 1 0 14 15.5z"></path></svg>',
      componentPath: ["SearchIcon"],
      children: [],
    };
    const source = inspectComponentSource(fixturePath("react/Avatar.tsx"));
    const capture = toCapture("default", iconRaw as unknown as RawDomSnapshot);
    const iconEvidence = buildComponentEvidence({ componentName: "SearchIcon", source, captures: [capture], analyzerVersion: "test" });
    const doc = buildDesignIR(iconEvidence, { componentDisplayName: "SearchIcon", variantAxes: [], nodeAnnotations: [] });

    expect(doc.assets).toHaveLength(1);
    expect(doc.assets[0].path.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(doc.assets[0].mimeType).toBe("image/svg+xml");
    // Falls back to the captured layout box, not naturalWidth/Height (both null for an inline svg).
    expect(doc.assets[0]).toMatchObject({ width: 24, height: 24 });
    const component = doc.components[0];
    if (component.kind !== "component") throw new Error("expected component");
    expect(component.root.type).toBe("image");
    if (component.root.type === "image") expect(component.root.assetId).toBe(doc.assets[0].id);
  });

  it("produces a document that passes @reactfig/core's validator despite dangling external instance references", () => {
    const result = validateDesignIR(doc);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe("buildDesignIR — node annotations (decorative skip, naming)", () => {
  it("honors a semanticName override on the root node", () => {
    const source = inspectComponentSource(fixturePath("react/Button.tsx"));
    const captures = [toCapture("default", loadRaw("button-default"))];
    const evidence = buildComponentEvidence({ componentName: "Button", source, captures, analyzerVersion: "test" });
    const interpretation: ComponentInterpretation = {
      componentDisplayName: "Button",
      variantAxes: [],
      nodeAnnotations: [{ path: [], semanticName: "Primary CTA Button" }],
    };
    const doc = buildDesignIR(evidence, interpretation);
    const component = doc.components[0];
    if (component.kind !== "component") throw new Error("expected component");
    expect(component.root.name).toBe("Primary CTA Button");
  });
});

describe("buildDesignIR — textAlign mapping (docs/adr/0014-structured-output-and-ir-construction.md)", () => {
  // Every existing fixture (button-default.json, session-card.json) hand-
  // authors text-align as "center" or "left" — values already inside
  // design-ir/v1's closed 4-value enum. That's exactly why the real bug
  // this test targets went undetected: `text-align: start` is the actual
  // CSS *initial* value in every modern browser, meaning any text node
  // that never had text-align explicitly set — the overwhelming majority
  // of real UI text — reports "start", not "left", from
  // getComputedStyle. A hand-built raw snapshot lets this test assert the
  // real-world default explicitly instead of relying on a fixture that
  // happens to dodge it.
  function rawTextElement(text: string, textAlign: string): RawDomSnapshot {
    return {
      tag: "span",
      attributes: { className: "label" },
      textContent: text,
      rect: { x: 0, y: 0, width: 80, height: 16 },
      computedStyle: {
        display: "inline",
        "font-family": "Inter",
        "font-size": "14px",
        "font-weight": "400",
        color: "rgb(0, 0, 0)",
        "text-align": textAlign,
      },
      naturalWidth: null,
      naturalHeight: null,
      componentPath: null,
      children: [],
    };
  }

  function buildFromRootRaw(raw: RawDomSnapshot) {
    const source = inspectComponentSource(fixturePath("react/Button.tsx"));
    const capture: RenderCapture = {
      label: "default",
      viewport: { width: 1440, height: 900 },
      dom: interpretDomSnapshot(raw),
      screenshot: null,
      contextScreenshot: null,
      capturedUrl: "http://localhost:3000",
      capturedAt: "2026-08-19T12:00:00.000Z",
    };
    const evidence = buildComponentEvidence({ componentName: "Button", source, captures: [capture], analyzerVersion: "test" });
    const interpretation: ComponentInterpretation = { componentDisplayName: "Label", variantAxes: [], nodeAnnotations: [] };
    return buildDesignIR(evidence, interpretation);
  }

  it("maps the real-world default computed value \"start\" to \"left\" and produces a schema-valid TextNode — the actual reported failure mode", () => {
    const doc = buildFromRootRaw(rawTextElement("Session with Alex", "start"));
    const component = doc.components[0];
    if (component.kind !== "component") throw new Error("expected component");
    expect(component.root.type).toBe("text");
    if (component.root.type !== "text") throw new Error("expected text node");
    expect(component.root.typography.textAlign).toBe("left");

    const result = validateDesignIR(doc);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("maps \"end\" to \"right\"", () => {
    const doc = buildFromRootRaw(rawTextElement("3:00 PM", "end"));
    const component = doc.components[0];
    if (component.kind !== "component" || component.root.type !== "text") throw new Error("expected text component");
    expect(component.root.typography.textAlign).toBe("right");
    expect(validateDesignIR(doc).valid).toBe(true);
  });

  it("passes through values already in the enum unchanged", () => {
    for (const [raw, expected] of [
      ["left", "left"],
      ["right", "right"],
      ["center", "center"],
      ["justify", "justify"],
    ] as const) {
      const doc = buildFromRootRaw(rawTextElement("x", raw));
      const component = doc.components[0];
      if (component.kind !== "component" || component.root.type !== "text") throw new Error("expected text component");
      expect(component.root.typography.textAlign).toBe(expected);
    }
  });

  it("omits textAlign (rather than fabricating a value) for a genuinely ambiguous computed value, and still produces valid IR", () => {
    for (const ambiguous of ["match-parent", "inherit", "initial", "unset", "some-future-css-value"]) {
      const doc = buildFromRootRaw(rawTextElement("x", ambiguous));
      const component = doc.components[0];
      if (component.kind !== "component" || component.root.type !== "text") throw new Error("expected text component");
      expect(component.root.typography.textAlign).toBeUndefined();
      expect(validateDesignIR(doc).valid).toBe(true);
    }
  });
});

describe("buildDesignIR — font-family stack collapsing (real reported failure: SessionCard font fallback)", () => {
  // Every existing fixture (button-default.json, session-card.json) hand-
  // authors font-family as a bare "Inter" — exactly why the real bug this
  // test targets went undetected: getComputedStyle always returns the
  // full author-specified fallback stack (e.g. `Inter, "Segoe UI",
  // system-ui, sans-serif`), never a single resolved name. Handing that
  // whole string to Figma's font loader (which requires one exact family
  // name) fails for virtually every real page and silently falls back to
  // Inter Regular — even when Inter itself was right there in the stack.
  function rawTextElement(text: string, fontFamily: string): RawDomSnapshot {
    return {
      tag: "span",
      attributes: { className: "label" },
      textContent: text,
      rect: { x: 0, y: 0, width: 80, height: 16 },
      computedStyle: {
        display: "inline",
        "font-family": fontFamily,
        "font-size": "14px",
        "font-weight": "600",
        color: "rgb(0, 0, 0)",
        "text-align": "left",
      },
      naturalWidth: null,
      naturalHeight: null,
      componentPath: null,
      children: [],
    };
  }

  function buildFromRootRaw(raw: RawDomSnapshot) {
    const source = inspectComponentSource(fixturePath("react/Button.tsx"));
    const capture: RenderCapture = {
      label: "default",
      viewport: { width: 1440, height: 900 },
      dom: interpretDomSnapshot(raw),
      screenshot: null,
      contextScreenshot: null,
      capturedUrl: "http://localhost:3000",
      capturedAt: "2026-08-19T12:00:00.000Z",
    };
    const evidence = buildComponentEvidence({ componentName: "Button", source, captures: [capture], analyzerVersion: "test" });
    const interpretation: ComponentInterpretation = { componentDisplayName: "Label", variantAxes: [], nodeAnnotations: [] };
    return buildDesignIR(evidence, interpretation);
  }

  it("collapses a full computed-style fallback stack to just its first specific name — the actual reported failure mode", () => {
    const doc = buildFromRootRaw(rawTextElement("Amir Hosseini", 'Inter, "Segoe UI", system-ui, sans-serif'));
    const component = doc.components[0];
    if (component.kind !== "component" || component.root.type !== "text") throw new Error("expected text component");
    expect(component.root.typography.fontFamily).toBe("Inter");
    expect(validateDesignIR(doc).valid).toBe(true);
  });

  it("passes a bare single family name through unchanged", () => {
    const doc = buildFromRootRaw(rawTextElement("x", "Inter"));
    const component = doc.components[0];
    if (component.kind !== "component" || component.root.type !== "text") throw new Error("expected text component");
    expect(component.root.typography.fontFamily).toBe("Inter");
  });

  it('falls back to "Inter" (never a generic CSS keyword) when the whole stack is generic', () => {
    const doc = buildFromRootRaw(rawTextElement("x", "system-ui, sans-serif"));
    const component = doc.components[0];
    if (component.kind !== "component" || component.root.type !== "text") throw new Error("expected text component");
    expect(component.root.typography.fontFamily).toBe("Inter");
  });
});

describe(
  "buildDesignIR — a styled leaf element (text + its own background/border/radius) becomes a frame with a text child, " +
    "not a bare text node (real reported failure: Badge/Button rendering as plain unstyled text, no pill/button box)",
  () => {
    // Badge.tsx's actual root: `<span class="badge badge-success">completed</span>`
    // — a single leaf element (no DOM children) that is simultaneously the
    // text AND its own styled pill: white text on a green rounded box with
    // a border. Before this fix, the leaf+textContent check routed this
    // straight to mapTextNode, which only ever captures typography + the
    // text's own (glyph) color — the green background, the border, and
    // the corner radius were silently dropped, so the badge rendered as
    // plain white text with nothing behind it (invisible against a white
    // canvas) instead of a pill.
    function badgeLikeRaw(padding?: { top: string; right: string; bottom: string; left: string }): RawDomSnapshot {
      return {
        tag: "span",
        attributes: { className: "badge badge-success" },
        textContent: "completed",
        rect: { x: 0, y: 0, width: 90, height: 28 },
        computedStyle: {
          display: "inline-block",
          "background-color": "rgb(34, 139, 87)",
          "border-radius": "999px",
          "border-top-width": "2px",
          "border-top-style": "solid",
          "border-top-color": "rgb(255, 255, 255)",
          "border-right-width": "2px",
          "border-right-style": "solid",
          "border-right-color": "rgb(255, 255, 255)",
          "border-bottom-width": "2px",
          "border-bottom-style": "solid",
          "border-bottom-color": "rgb(255, 255, 255)",
          "border-left-width": "2px",
          "border-left-style": "solid",
          "border-left-color": "rgb(255, 255, 255)",
          "font-family": "Inter",
          "font-size": "12px",
          "font-weight": "600",
          color: "rgb(255, 255, 255)",
          ...(padding
            ? { "padding-top": padding.top, "padding-right": padding.right, "padding-bottom": padding.bottom, "padding-left": padding.left }
            : {}),
        },
        naturalWidth: null,
        naturalHeight: null,
        componentPath: null,
        children: [],
      };
    }

    function buildFromRootRaw(raw: RawDomSnapshot) {
      const source = inspectComponentSource(fixturePath("react/Button.tsx"));
      const capture: RenderCapture = {
        label: "default",
        viewport: { width: 1440, height: 900 },
        dom: interpretDomSnapshot(raw),
        screenshot: null,
        contextScreenshot: null,
        capturedUrl: "http://localhost:3000",
        capturedAt: "2026-08-19T12:00:00.000Z",
      };
      const evidence = buildComponentEvidence({ componentName: "Badge", source, captures: [capture], analyzerVersion: "test" });
      const interpretation: ComponentInterpretation = { componentDisplayName: "Badge", variantAxes: [], nodeAnnotations: [] };
      return buildDesignIR(evidence, interpretation);
    }

    it("produces a frame root (not text) carrying the background fill, border stroke, and corner radius", () => {
      const doc = buildFromRootRaw(badgeLikeRaw());
      const component = doc.components[0];
      if (component.kind !== "component" || component.root.type !== "frame") throw new Error("expected frame component");
      expect(component.root.fills).toEqual([{ type: "solid", color: { r: 34 / 255, g: 139 / 255, b: 87 / 255, a: 1 } }]);
      expect(component.root.strokes).toEqual([{ color: { r: 1, g: 1, b: 1, a: 1 }, width: 2, style: "solid" }]);
      expect(component.root.cornerRadius).toBe(999); // border-radius: 999px is a valid px token as authored — parseCornerRadius doesn't clamp to box size, matching Figma's own "999 = always fully round" convention
    });

    it("leaves strokeWeights unset for a uniform border on all four sides — Stroke.width alone already says everything", () => {
      const doc = buildFromRootRaw(badgeLikeRaw());
      const component = doc.components[0];
      if (component.kind !== "component" || component.root.type !== "frame") throw new Error("expected frame component");
      expect(component.root.strokeWeights).toBeUndefined();
    });

    it("preserves the actual text — characters, typography, and glyph color — as a single synthesized child, not lost", () => {
      const doc = buildFromRootRaw(badgeLikeRaw());
      const component = doc.components[0];
      if (component.kind !== "component" || component.root.type !== "frame") throw new Error("expected frame component");
      expect(component.root.children).toHaveLength(1);
      const child = component.root.children[0];
      if (child.type !== "text") throw new Error("expected text child");
      expect(child.characters).toBe("completed");
      expect(child.fills).toEqual([{ type: "solid", color: { r: 1, g: 1, b: 1, a: 1 } }]);
    });

    it("produces schema-valid design-ir/v1 (a real end-to-end concern, not just individual field checks)", () => {
      const doc = buildFromRootRaw(badgeLikeRaw());
      expect(validateDesignIR(doc).valid).toBe(true);
    });

    it("still maps a plain leaf text element (no background/border/radius) to a bare text node, unchanged — this fix must not wrap every label in an unnecessary frame", () => {
      const plain: RawDomSnapshot = {
        tag: "span",
        attributes: { className: "label" },
        textContent: "Today, 4:00 PM",
        rect: { x: 0, y: 0, width: 120, height: 16 },
        computedStyle: { display: "inline", "font-family": "Inter", "font-size": "14px", color: "rgb(100, 100, 100)" },
        naturalWidth: null,
        naturalHeight: null,
        componentPath: null,
        children: [],
      };
      const doc = buildFromRootRaw(plain);
      const component = doc.components[0];
      expect(component.kind === "component" && component.root.type).toBe("text");
    });
  }
);

describe(
  "buildDesignIR — mixed per-side border (real reported failure: StatCard's border-left accent stripe not rendering)",
  () => {
    // StatCard.css: `.stat-card { border: 1px solid gray; border-left: 4px solid green; }`
    function statCardRaw(): RawDomSnapshot {
      return {
        tag: "div",
        attributes: { className: "stat-card" },
        textContent: null,
        rect: { x: 0, y: 0, width: 140, height: 80 },
        computedStyle: {
          display: "block",
          "background-color": "rgb(255, 255, 255)",
          "border-top-width": "1px",
          "border-top-style": "solid",
          "border-top-color": "rgb(200, 200, 200)",
          "border-right-width": "1px",
          "border-right-style": "solid",
          "border-right-color": "rgb(200, 200, 200)",
          "border-bottom-width": "1px",
          "border-bottom-style": "solid",
          "border-bottom-color": "rgb(200, 200, 200)",
          "border-left-width": "4px",
          "border-left-style": "solid",
          "border-left-color": "rgb(34, 139, 34)",
        },
        naturalWidth: null,
        naturalHeight: null,
        componentPath: null,
        children: [],
      };
    }

    function buildFromRootRaw(raw: RawDomSnapshot) {
      const source = inspectComponentSource(fixturePath("react/Button.tsx"));
      const capture: RenderCapture = {
        label: "default",
        viewport: { width: 1440, height: 900 },
        dom: interpretDomSnapshot(raw),
        screenshot: null,
        contextScreenshot: null,
        capturedUrl: "http://localhost:3000",
        capturedAt: "2026-08-19T12:00:00.000Z",
      };
      const evidence = buildComponentEvidence({ componentName: "StatCard", source, captures: [capture], analyzerVersion: "test" });
      const interpretation: ComponentInterpretation = { componentDisplayName: "StatCard", variantAxes: [], nodeAnnotations: [] };
      return buildDesignIR(evidence, interpretation);
    }

    it("produces a real stroke (the left accent's own color) rather than dropping the border entirely", () => {
      const doc = buildFromRootRaw(statCardRaw());
      const component = doc.components[0];
      if (component.kind !== "component" || component.root.type !== "frame") throw new Error("expected frame component");
      // The left side is the paint source — it's the widest side (4px, vs. 1px for the
      // other three), which is what makes it the accent. Picking whichever side happened
      // to be captured/ordered first (top, in this fixture) would silently pick the
      // shared gray instead — the exact bug this fixture reproduces.
      expect(component.root.strokes).toHaveLength(1);
      expect(component.root.strokes?.[0].width).toBe(4);
      expect(component.root.strokes?.[0].color).toEqual({ r: 34 / 255, g: 139 / 255, b: 34 / 255, a: 1 });
    });

    it("carries strokeWeights with the four sides' actual differing widths — this is what lets the left accent survive rendering distinct from the other three sides", () => {
      const doc = buildFromRootRaw(statCardRaw());
      const component = doc.components[0];
      if (component.kind !== "component" || component.root.type !== "frame") throw new Error("expected frame component");
      expect(component.root.strokeWeights).toEqual({ top: 1, right: 1, bottom: 1, left: 4 });
    });

    it("produces schema-valid design-ir/v1 with strokeWeights present", () => {
      const doc = buildFromRootRaw(statCardRaw());
      expect(validateDesignIR(doc).valid).toBe(true);
    });
  }
);

describe("buildDesignIR — gradient and image backgrounds (mapFrameNode fill building)", () => {
  function rawFrame(overrides: Partial<Record<string, string>>): RawDomSnapshot {
    return {
      tag: "div",
      attributes: { className: "banner" },
      textContent: null,
      rect: { x: 0, y: 0, width: 320, height: 120 },
      computedStyle: {
        display: "block",
        "background-color": "rgba(0, 0, 0, 0)",
        "background-image": "none",
        "border-top-width": "0px",
        "border-top-style": "none",
        "border-top-color": "rgb(0, 0, 0)",
        "border-radius": "0px",
        "box-shadow": "none",
        opacity: "1",
        overflow: "visible",
        ...overrides,
      },
      naturalWidth: null,
      naturalHeight: null,
      componentPath: null,
      children: [],
    };
  }

  function buildFromRootRaw(raw: RawDomSnapshot) {
    const source = inspectComponentSource(fixturePath("react/Button.tsx"));
    const capture: RenderCapture = {
      label: "default",
      viewport: { width: 1440, height: 900 },
      dom: interpretDomSnapshot(raw),
      screenshot: null,
      contextScreenshot: null,
      capturedUrl: "http://localhost:3000",
      capturedAt: "2026-08-19T12:00:00.000Z",
    };
    const evidence = buildComponentEvidence({ componentName: "Banner", source, captures: [capture], analyzerVersion: "test" });
    const interpretation: ComponentInterpretation = { componentDisplayName: "Banner", variantAxes: [], nodeAnnotations: [] };
    return buildDesignIR(evidence, interpretation);
  }

  function rootFrame(doc: ReturnType<typeof buildFromRootRaw>) {
    const component = doc.components[0];
    if (component.kind !== "component" || component.root.type !== "frame") throw new Error("expected frame component");
    return component.root;
  }

  it("translates a CSS linear-gradient background into a real linearGradient Fill", () => {
    const doc = buildFromRootRaw(rawFrame({ "background-image": "linear-gradient(90deg, rgb(255, 0, 0), rgb(0, 0, 255))" }));
    const root = rootFrame(doc);
    expect(root.fills).toEqual([
      {
        type: "linearGradient",
        angleDeg: 0,
        stops: [
          { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
          { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
        ],
      },
    ]);
    expect(validateDesignIR(doc).valid).toBe(true);
  });

  it("a gradient fill and a solid background-color fill can coexist (gradient on top, solid at bottom — matching CSS's background-image-over-background-color layering; Figma's fills array paints later entries on top, so the bottom-most paint is fills[0])", () => {
    const doc = buildFromRootRaw(
      rawFrame({
        "background-image": "linear-gradient(to right, rgb(255, 0, 0), rgb(0, 0, 255))",
        "background-color": "rgb(20, 20, 20)",
      })
    );
    const root = rootFrame(doc);
    expect(root.fills?.map((f) => f.type)).toEqual(["solid", "linearGradient"]);
  });

  it("uses the element's own bounds for a 'to <corner>' gradient's aspect-ratio-dependent angle", () => {
    const doc = buildFromRootRaw(rawFrame({ "background-image": "linear-gradient(to top right, rgb(255, 0, 0), rgb(0, 0, 255))" }));
    const root = rootFrame(doc);
    const fill = root.fills?.[0];
    if (fill?.type !== "linearGradient") throw new Error("expected linearGradient fill");
    // rect is 320x120 (non-square) in rawFrame() -> not the symmetric 45°/315° case.
    expect(fill.angleDeg).not.toBe(315);
  });

  it("still falls back to a plain image Fill for a non-gradient background-image (regression check against the existing url() path)", () => {
    const raw = loadRaw("hero-banner");
    const capture = toCapture("default", raw);
    const source = inspectComponentSource(fixturePath("react/Button.tsx"));
    const evidence = buildComponentEvidence({ componentName: "HeroBanner", source, captures: [capture], analyzerVersion: "test" });
    const interpretation: ComponentInterpretation = { componentDisplayName: "HeroBanner", variantAxes: [], nodeAnnotations: [] };
    const doc = buildDesignIR(evidence, interpretation);
    const root = rootFrame(doc);
    // The image layer is the topmost (last) fill — this fixture also has
    // its own background-color, which now correctly sits at the bottom
    // (fills[0]) rather than covering the image.
    expect(root.fills?.at(-1)).toMatchObject({ type: "image" });
    expect(doc.assets).toHaveLength(1);
  });

  it("translates a CSS radial-gradient background into a real radialGradient Fill, centered by default (no 'at X Y' clause)", () => {
    const doc = buildFromRootRaw(rawFrame({ "background-image": "radial-gradient(circle, rgb(255, 0, 0), rgb(0, 0, 255))" }));
    const root = rootFrame(doc);
    expect(root.fills).toEqual([
      {
        type: "radialGradient",
        centerX: 0.5,
        centerY: 0.5,
        stops: [
          { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
          { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
        ],
      },
    ]);
  });

  it("uses the 'at X% Y%' clause for an off-center radial gradient, when present", () => {
    const doc = buildFromRootRaw(rawFrame({ "background-image": "radial-gradient(circle at 30% 70%, rgb(255, 0, 0), rgb(0, 0, 255))" }));
    const root = rootFrame(doc);
    expect(root.fills?.[0]).toMatchObject({ type: "radialGradient", centerX: 0.3, centerY: 0.7 });
  });

  it("translates a CSS conic-gradient background into a real conicGradient Fill", () => {
    const doc = buildFromRootRaw(rawFrame({ "background-image": "conic-gradient(from 45deg at 30% 70%, rgb(255, 0, 0), rgb(0, 0, 255))" }));
    const root = rootFrame(doc);
    expect(root.fills?.[0]).toMatchObject({ type: "conicGradient", startAngleDeg: 45, centerX: 0.3, centerY: 0.7 });
  });

  it("stacks a multi-layer background-image — a gradient layered over a photo, first-listed layer on top (matching CSS layering; Figma's fills array paints last-entry-on-top)", () => {
    const doc = buildFromRootRaw(
      rawFrame({
        "background-image": 'linear-gradient(to bottom, rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0)), url("photo.png")',
      })
    );
    const root = rootFrame(doc);
    // url() layer (listed second in CSS, so bottom-most among the image
    // layers) comes first in fills[]; the gradient (listed first in CSS,
    // topmost) comes last — on top, as a real "gradient scrim over a
    // photo" pattern needs to render.
    expect(root.fills?.map((f) => f.type)).toEqual(["image", "linearGradient"]);
  });

  it("stacks two gradient layers in the correct order, and prepends background-color at the very bottom under both", () => {
    const doc = buildFromRootRaw(
      rawFrame({
        "background-image": "radial-gradient(circle at 20% 20%, rgb(255, 0, 0), rgb(0, 0, 255)), linear-gradient(to right, rgb(0, 255, 0), rgb(255, 255, 0))",
        "background-color": "rgb(10, 10, 10)",
      })
    );
    const root = rootFrame(doc);
    expect(root.fills?.map((f) => f.type)).toEqual(["solid", "linearGradient", "radialGradient"]);
  });

  it("drops an unparseable/'none' layer from the stack without blocking the layers around it", () => {
    const doc = buildFromRootRaw(
      rawFrame({
        "background-image": 'linear-gradient(to right, rgb(255, 0, 0), rgb(0, 0, 255)), none, url("photo.png")',
      })
    );
    const root = rootFrame(doc);
    expect(root.fills?.map((f) => f.type)).toEqual(["image", "linearGradient"]);
  });
});

describe("buildDesignIR — interaction-state variants (hover/focus/active — docs/adr/0023-interaction-state-capture.md)", () => {
  const source = inspectComponentSource(fixturePath("react/Button.tsx"));

  it("builds a componentSet with a 'state' axis when captures carry interactionState, with no model-confirmed variantAxes needed at all", () => {
    const captures = [toCapture("default", loadRaw("button-default"), undefined, undefined), toCapture("hover", loadRaw("button-secondary-large"), undefined, "hover")];
    const evidence = buildComponentEvidence({ componentName: "Button", source, captures, analyzerVersion: "test" });
    const interpretation: ComponentInterpretation = { componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] };
    const doc = buildDesignIR(evidence, interpretation);

    const component = doc.components[0];
    expect(component.kind).toBe("componentSet");
    if (component.kind !== "componentSet") return;
    expect(component.variantProperties).toEqual([{ name: "state", values: ["default", "hover"] }]);
    expect(component.variants.map((v) => v.propertyValues)).toEqual([{ state: "default" }, { state: "hover" }]);
  });

  it("treats a capture with no interactionState as state: 'default' once the axis is active — not a fourth, unlabeled state", () => {
    const captures = [toCapture("default", loadRaw("button-default")), toCapture("focus", loadRaw("button-secondary-large"), undefined, "focus")];
    const evidence = buildComponentEvidence({ componentName: "Button", source, captures, analyzerVersion: "test" });
    const interpretation: ComponentInterpretation = { componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] };
    const doc = buildDesignIR(evidence, interpretation);
    const component = doc.components[0];
    if (component.kind !== "componentSet") throw new Error("expected componentSet");
    expect(component.variants.find((v) => v.propertyValues.state === "default")).toBeDefined();
  });

  it("composes a prop-driven axis (model-confirmed) together with the deterministic state axis when a capture has both", () => {
    const captures = [
      toCapture("primary-default", loadRaw("button-default"), { variant: "primary" }, undefined),
      toCapture("primary-hover", loadRaw("button-secondary-large"), { variant: "primary" }, "hover"),
    ];
    const evidence = buildComponentEvidence({ componentName: "Button", source, captures, analyzerVersion: "test" });
    const interpretation: ComponentInterpretation = { componentDisplayName: "Button", variantAxes: [{ propName: "variant", values: ["primary"] }], nodeAnnotations: [] };
    const doc = buildDesignIR(evidence, interpretation);
    const component = doc.components[0];
    if (component.kind !== "componentSet") throw new Error("expected componentSet");
    expect(component.variantProperties).toEqual([
      { name: "variant", values: ["primary"] },
      { name: "state", values: ["default", "hover"] },
    ]);
    expect(component.variants.map((v) => v.propertyValues)).toEqual([
      { variant: "primary", state: "default" },
      { variant: "primary", state: "hover" },
    ]);
  });

  it("produces a plain component (not a componentSet) when no capture has an interactionState and there are no confirmed prop axes either — unchanged existing behavior", () => {
    const captures = [toCapture("default", loadRaw("button-default"))];
    const evidence = buildComponentEvidence({ componentName: "Button", source, captures, analyzerVersion: "test" });
    const interpretation: ComponentInterpretation = { componentDisplayName: "Button", variantAxes: [], nodeAnnotations: [] };
    const doc = buildDesignIR(evidence, interpretation);
    expect(doc.components[0].kind).toBe("component");
  });
});