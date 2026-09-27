import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { interpretDomSnapshot } from "../src/evidence/interpretDomSnapshot.js";
import { COMPUTED_STYLE_PROPERTIES } from "../src/browser/collectDomSnapshot.js";
import type { RawDomSnapshot } from "../src/browser/rawTypes.js";
import { parseColor, parsePx, parseCornerRadius, classifyLayoutMode } from "../src/evidence/parse.js";

function loadFixture(name: string): RawDomSnapshot {
  const path = fileURLToPath(new URL(`./fixtures/raw-snapshots/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("parse helpers", () => {
  it("parsePx", () => {
    expect(parsePx("16px")).toBe(16);
    expect(parsePx("auto")).toBeNull();
    expect(parsePx(undefined)).toBeNull();
  });

  it("parseColor resolves rgb/rgba to 0-1 floats and keeps the raw string", () => {
    const c = parseColor("rgb(28, 97, 250)");
    expect(c?.raw).toBe("rgb(28, 97, 250)");
    expect(c?.parsed?.r).toBeCloseTo(28 / 255);
    expect(c?.parsed?.a).toBe(1);
  });

  it("parseColor treats 'none'/'transparent' as fully transparent, not unparseable", () => {
    expect(parseColor("transparent")?.parsed).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it("parseCornerRadius handles uniform and 4-value px forms", () => {
    expect(parseCornerRadius("8px", { width: 100, height: 100 })).toBe(8);
    expect(parseCornerRadius("8px 8px 0px 0px", { width: 100, height: 100 })).toEqual([8, 8, 0, 0]);
  });

  it(
    "parseCornerRadius resolves a percentage against the element's own box — " +
      "the actual reported bug (a circular avatar, border-radius: 50%, rendering as a square)",
    () => {
      // Avatar.css: `.avatar { border-radius: 50%; }` on a 48x48 box —
      // this must resolve to 24, not silently drop to null (which
      // mapCornerRadius in buildDesignIR.ts turns into `undefined`,
      // i.e. no rounding applied at all).
      expect(parseCornerRadius("50%", { width: 48, height: 48 })).toBe(24);
    }
  );

  it("parseCornerRadius approximates a percentage on a non-square box against the shorter side, rather than dropping it", () => {
    expect(parseCornerRadius("50%", { width: 48, height: 32 })).toBe(16);
  });

  it("parseCornerRadius handles a mixed px/percentage 4-value list", () => {
    expect(parseCornerRadius("8px 50% 0px 0px", { width: 40, height: 40 })).toEqual([8, 20, 0, 0]);
  });

  it("parseCornerRadius leaves distinct horizontal/vertical (\"/\") radii unparsed, same as before — not representable by a single cornerRadius number", () => {
    expect(parseCornerRadius("50% / 20%", { width: 100, height: 40 })).toBeNull();
  });

  it("classifyLayoutMode", () => {
    expect(classifyLayoutMode("flex")).toBe("flex");
    expect(classifyLayoutMode("grid")).toBe("grid");
    expect(classifyLayoutMode("block")).toBe("block");
  });
});

describe("interpretDomSnapshot — Button (flex layout, typography, box-shadow)", () => {
  const evidence = interpretDomSnapshot(loadFixture("button-default"));

  it("classifies the root as flex layout with parsed flex properties", () => {
    expect(evidence.style.layoutMode).toBe("flex");
    expect(evidence.style.flex).toEqual({
      direction: "row",
      justifyContent: "center",
      alignItems: "center",
      wrap: "nowrap",
      gap: 8,
      rowGap: 8,
      columnGap: 8,
    });
  });

  it("parses padding into a structured box", () => {
    expect(evidence.style.padding).toEqual({ top: 12, right: 24, bottom: 12, left: 24 });
  });

  it("parses background color and preserves raw box-shadow", () => {
    expect(evidence.style.backgroundColor?.parsed?.b).toBeCloseTo(250 / 255);
    expect(evidence.style.boxShadow).toBe("rgba(0, 0, 0, 0.15) 0px 1px 2px 0px");
  });

  it("captures typography for the label text", () => {
    const label = evidence.children[0];
    expect(label.textContent).toBe("Get started");
    expect(label.style.typography.fontFamily).toBe("Inter");
    expect(label.style.typography.fontSizePx).toBe(16);
    expect(label.style.typography.fontWeight).toBe("600");
  });

  it("has no border evidence when border-style is 'none'", () => {
    expect(evidence.style.border).toBeNull();
  });
});

describe("interpretDomSnapshot — Button secondary/large variant", () => {
  const evidence = interpretDomSnapshot(loadFixture("button-secondary-large"));

  it("captures a real border when border-style is solid, uniformly on all four sides", () => {
    const side = { widthPx: 1, style: "solid", color: expect.objectContaining({ raw: "rgb(28, 97, 250)" }) };
    expect(evidence.style.border).toEqual({ top: side, right: side, bottom: side, left: side });
  });

  it("captures the larger bounds distinct from the primary/medium variant", () => {
    expect(evidence.bounds).toEqual({ x: 40, y: 40, width: 180, height: 56 });
  });
});

describe("interpretDomSnapshot — mixed per-side border (StatCard's left accent stripe: the actual reported bug)", () => {
  // StatCard.css: `.stat-card { border: 1px solid gray; border-left: 4px solid green; }`
  // — a uniform 1px border on three sides, plus a distinct 4px left edge in
  // a different color. Reading only border-top-* and treating it as "the"
  // border for every side (the old behavior) sees a uniform 1px gray
  // border and drops the left accent entirely; this must capture all four
  // sides independently.
  function statCardSnapshot(): RawDomSnapshot {
    return {
      tag: "div",
      attributes: { className: "stat-card" },
      textContent: null,
      rect: { x: 0, y: 0, width: 140, height: 80 },
      computedStyle: {
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

  it("captures the left side's distinct 4px width and color, not silently dropped or overwritten by the other sides", () => {
    const evidence = interpretDomSnapshot(statCardSnapshot());
    expect(evidence.style.border?.left).toEqual({ widthPx: 4, style: "solid", color: expect.objectContaining({ raw: "rgb(34, 139, 34)" }) });
  });

  it("still captures the other three sides' own (different) 1px gray border independently", () => {
    const evidence = interpretDomSnapshot(statCardSnapshot());
    const grayThinSide = { widthPx: 1, style: "solid", color: expect.objectContaining({ raw: "rgb(200, 200, 200)" }) };
    expect(evidence.style.border?.top).toEqual(grayThinSide);
    expect(evidence.style.border?.right).toEqual(grayThinSide);
    expect(evidence.style.border?.bottom).toEqual(grayThinSide);
  });

  it("a side with no border at all (border-style: none) is captured as null, not a phantom zero-width border", () => {
    const raw = statCardSnapshot();
    raw.computedStyle["border-bottom-style"] = "none";
    raw.computedStyle["border-bottom-width"] = "0px";
    const evidence = interpretDomSnapshot(raw);
    expect(evidence.style.border?.bottom).toBeNull();
    expect(evidence.style.border?.left).not.toBeNull(); // the other sides are unaffected
  });
});

describe("interpretDomSnapshot — SessionCard (nested, image asset, CSS Grid preservation)", () => {
  const evidence = interpretDomSnapshot(loadFixture("session-card"));

  it("captures nested typography for the title", () => {
    const title = evidence.children[0];
    expect(title.tag).toBe("h3");
    expect(title.textContent).toBe("Amir Hosseini");
    expect(title.style.typography.fontWeight).toBe("700");
  });

  it("classifies the row as grid and preserves raw grid-template evidence", () => {
    const row = evidence.children[1];
    expect(row.style.layoutMode).toBe("grid");
    expect(row.style.grid).toEqual({
      templateColumns: "80px 1fr",
      templateRows: "auto auto",
      autoFlow: "row",
      gap: 12,
      rowGap: 12,
      columnGap: 12,
    });
  });

  it("captures each grid child's own placement evidence", () => {
    const row = evidence.children[1];
    const avatar = row.children[0];
    const badge = row.children[1];
    expect(avatar.style.gridChildPlacement).toEqual({ column: "1 / 2", row: "1 / 3" });
    expect(badge.style.gridChildPlacement).toEqual({ column: "2 / 3", row: "1 / 2" });
  });

  it("does not attach grid-child placement to nodes whose parent isn't grid", () => {
    const title = evidence.children[0]; // child of the card div (display:block), not the grid row
    expect(title.style.gridChildPlacement).toBeNull();
  });

  it("captures the image asset with its natural dimensions", () => {
    const row = evidence.children[1];
    const avatar = row.children[0];
    expect(avatar.image).toEqual({
      src: "/avatars/amir.png",
      naturalWidth: 256,
      naturalHeight: 256,
      alt: "Amir Hosseini",
    });
  });
});

describe("interpretDomSnapshot — componentPath / isComponentRoot (source ↔ rendered mapping)", () => {
  const evidence = interpretDomSnapshot(loadFixture("session-card"));

  it("the capture root carries the full ownership path and is its own component root", () => {
    expect(evidence.componentPath).toEqual(["SessionCard", "Card"]);
    expect(evidence.isComponentRoot).toBe(true); // no parent — trivially a root
  });

  it("a plain host element owned by the same component as its parent is not a new component root", () => {
    const title = evidence.children[0]; // h3, owned by Card, same as its parent div.card
    expect(title.componentPath).toEqual(["SessionCard", "Card"]);
    expect(title.isComponentRoot).toBe(false);
  });

  it("an element authored directly by the outer component (pass-through content) is flagged as re-entering that component's ownership", () => {
    const row = evidence.children[1]; // div.session-card-row, authored by SessionCard itself, not Card
    expect(row.componentPath).toEqual(["SessionCard"]);
    expect(row.isComponentRoot).toBe(true); // differs from parent's nearest owner ("Card")
  });

  it("distinguishes nested component instances (Avatar, Badge) from each other and from ordinary DOM", () => {
    const row = evidence.children[1];
    const avatar = row.children[0];
    const badge = row.children[1];
    expect(avatar.componentPath).toEqual(["SessionCard", "Avatar"]);
    expect(avatar.isComponentRoot).toBe(true);
    expect(badge.componentPath).toEqual(["SessionCard", "Badge"]);
    expect(badge.isComponentRoot).toBe(true);
    // Two different component instances at the same tree depth are not conflated.
    expect(avatar.componentPath).not.toEqual(badge.componentPath);
  });

  it("gracefully returns null when componentPath is unavailable (e.g. non-React DOM, production build)", () => {
    const raw = loadFixture("button-default");
    // simulate a fiber-less element
    (raw as any).componentPath = null;
    const result = interpretDomSnapshot(raw);
    expect(result.componentPath).toBeNull();
    expect(result.isComponentRoot).toBe(false); // componentPath null => never flagged a root
  });
});

describe("interpretDomSnapshot — margin, z-index, corner radius (raw + parsed)", () => {
  it("captures margin as a structured box, distinct from padding", () => {
    const raw = loadFixture("button-default");
    raw.computedStyle["margin-top"] = "4px";
    raw.computedStyle["margin-right"] = "0px";
    raw.computedStyle["margin-bottom"] = "4px";
    raw.computedStyle["margin-left"] = "0px";
    const evidence = interpretDomSnapshot(raw);
    expect(evidence.style.margin).toEqual({ top: 4, right: 0, bottom: 4, left: 0 });
  });

  it("captures z-index only when set to a real value, not 'auto'", () => {
    const raw = loadFixture("session-card");
    raw.children[1].children[1].computedStyle["z-index"] = "2"; // badge overlapping avatar
    const evidence = interpretDomSnapshot(raw);
    expect(evidence.children[1].children[1].style.zIndex).toBe(2);
    expect(evidence.style.zIndex).toBeNull(); // card root never set z-index => "auto" => null
  });

  it("preserves both the raw border-radius string and its parsed px form", () => {
    const evidence = interpretDomSnapshot(loadFixture("session-card"));
    expect(evidence.style.cornerRadius).toEqual({ raw: "12px", parsedPx: 12 });
  });

  it(
    "resolves a percentage border-radius against the element's own captured rect — " +
      "end-to-end regression for the reported bug (an Avatar's border-radius: 50% rendering as a square in Figma)",
    () => {
      const raw = loadFixture("session-card");
      // session-card.json's avatar node (children[1].children[0], per the
      // z-index test above addressing its sibling badge) — override its
      // border-radius to match Avatar.css in examples/sample-react-app
      // (`border-radius: 50%`) on its real 48x48 box.
      const avatarNode = raw.children[1].children[0];
      avatarNode.computedStyle["border-radius"] = "50%";
      avatarNode.rect = { x: avatarNode.rect.x, y: avatarNode.rect.y, width: 48, height: 48 };
      const evidence = interpretDomSnapshot(raw);
      const avatarEvidence = evidence.children[1].children[0];
      expect(avatarEvidence.style.cornerRadius).toEqual({ raw: "50%", parsedPx: 24 });
    }
  );
});

describe("interpretDomSnapshot — background-image assets (concern: assets)", () => {
  it("extracts the URL from a CSS background-image url() reference", () => {
    const evidence = interpretDomSnapshot(loadFixture("hero-banner"));
    expect(evidence.style.backgroundImage).toBe('url("/banners/welcome.jpg")');
    expect(evidence.style.backgroundImageUrl).toBe("/banners/welcome.jpg");
  });

  it("does not extract a URL from a solid background-color-only element", () => {
    const evidence = interpretDomSnapshot(loadFixture("button-default"));
    expect(evidence.style.backgroundImageUrl).toBeNull();
  });
});

describe("interpretDomSnapshot — extended typography (fidelity: style, wrapping)", () => {
  it("captures font-style, white-space, and text-overflow for truncation fidelity", () => {
    const raw = loadFixture("session-card");
    raw.children[0].computedStyle["font-style"] = "italic";
    raw.children[0].computedStyle["white-space"] = "nowrap";
    raw.children[0].computedStyle["text-overflow"] = "ellipsis";
    const evidence = interpretDomSnapshot(raw);
    const title = evidence.children[0];
    expect(title.style.typography.fontStyle).toBe("italic");
    expect(title.style.typography.whiteSpace).toBe("nowrap");
    expect(title.style.typography.textOverflow).toBe("ellipsis");
  });

  it("parses line-height and letter-spacing to px only when in px form", () => {
    const button = interpretDomSnapshot(loadFixture("button-default"));
    const label = button.children[0];
    expect(label.style.typography.lineHeight).toBe("24px");
    expect(label.style.typography.lineHeightPx).toBe(24);

    const normalLineHeight = interpretDomSnapshot(loadFixture("session-card"));
    expect(normalLineHeight.style.typography.lineHeight).toBe("normal");
    expect(normalLineHeight.style.typography.lineHeightPx).toBeNull();
  });
});

describe("interpretDomSnapshot — responsive: same element, two viewports", () => {
  it("desktop capture is a CSS Grid, mobile capture is a vertical flex column", () => {
    const desktopRow = interpretDomSnapshot(loadFixture("session-card")).children[1];
    const mobileRow = interpretDomSnapshot(loadFixture("session-card-row-mobile"));

    expect(desktopRow.style.layoutMode).toBe("grid");
    expect(mobileRow.style.layoutMode).toBe("flex");
    expect(mobileRow.style.flex?.direction).toBe("column");
    // Same semantic row, different rendered layout mode per viewport — exactly the
    // "responsive/rendered state" evidence AI reasoning needs to reconcile later.
    expect(mobileRow.bounds.width).toBeLessThan(desktopRow.bounds.width);
  });
});

describe("collectDomSnapshot's COMPUTED_STYLE_PROPERTIES allow-list -> interpretDomSnapshot, end to end (real reported failure: StatCard's left accent border missing in every real capture, even though interpretDomSnapshot itself already handled a fully-populated per-side border correctly)", () => {
  it("recovers a real, distinct left-side border from a computedStyle object containing only keys the actual browser-side allow-list would supply — not a hand-picked superset", () => {
    // Deliberately built from COMPUTED_STYLE_PROPERTIES itself (imported
    // from the real collectDomSnapshot module, not re-typed by hand) and
    // nothing else, so this fails the same way a real browser capture
    // would if any border-<side>-* property were ever missing from that
    // list again — unlike the other per-side-border test above, which
    // constructs its own computedStyle by hand and so can't catch a gap
    // in the allow-list itself (this exact gap shipped silently before:
    // interpretDomSnapshot already correctly built a 4-sided BorderEvidence
    // when given one, but collectDomSnapshot's allow-list only ever
    // requested border-top-*, so a real capture never supplied the other
    // three sides' values to interpret in the first place).
    const values: Record<string, string> = {
      "border-top-width": "1px",
      "border-top-style": "solid",
      "border-top-color": "rgb(226, 228, 233)",
      "border-right-width": "1px",
      "border-right-style": "solid",
      "border-right-color": "rgb(226, 228, 233)",
      "border-bottom-width": "1px",
      "border-bottom-style": "solid",
      "border-bottom-color": "rgb(226, 228, 233)",
      "border-left-width": "4px",
      "border-left-style": "solid",
      "border-left-color": "rgb(22, 163, 74)",
    };
    const computedStyle: Record<string, string> = {};
    for (const prop of COMPUTED_STYLE_PROPERTIES) computedStyle[prop] = values[prop] ?? "";

    const raw: RawDomSnapshot = {
      tag: "div",
      attributes: { className: "stat-card stat-card-success" },
      textContent: null,
      rect: { x: 0, y: 0, width: 200, height: 80 },
      computedStyle,
      naturalWidth: null,
      naturalHeight: null,
      svgMarkup: null,
      componentPath: null,
      children: [],
    };

    const evidence = interpretDomSnapshot(raw);
    expect(evidence.style.border?.left).toEqual({ widthPx: 4, style: "solid", color: { raw: "rgb(22, 163, 74)", parsed: { r: 22 / 255, g: 163 / 255, b: 74 / 255, a: 1 } } });
    expect(evidence.style.border?.top).toEqual({ widthPx: 1, style: "solid", color: { raw: "rgb(226, 228, 233)", parsed: { r: 226 / 255, g: 228 / 255, b: 233 / 255, a: 1 } } });
    // The actual bug, precisely: left must NOT collapse to the same value
    // as top just because only top used to be captured.
    expect(evidence.style.border?.left).not.toEqual(evidence.style.border?.top);
  });
});

describe("interpretDomSnapshot — inline <svg> icon evidence (docs/adr/0030)", () => {
  function svgSnapshot(overrides: Partial<RawDomSnapshot> = {}): RawDomSnapshot {
    const computedStyle: Record<string, string> = {};
    for (const prop of COMPUTED_STYLE_PROPERTIES) computedStyle[prop] = "";
    return {
      tag: "svg",
      attributes: {},
      textContent: null,
      rect: { x: 10, y: 10, width: 24, height: 24 },
      computedStyle,
      naturalWidth: null,
      naturalHeight: null,
      svgMarkup: '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"></path></svg>',
      componentPath: null,
      children: [],
      ...overrides,
    };
  }

  it("builds an image evidence entry from svgMarkup, base64-encoded as a data:image/svg+xml URI", () => {
    const evidence = interpretDomSnapshot(svgSnapshot());
    expect(evidence.image).not.toBeNull();
    expect(evidence.image!.src.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const decoded = Buffer.from(evidence.image!.src.split(",")[1], "base64").toString("utf-8");
    expect(decoded).toBe('<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"></path></svg>');
  });

  it("falls back to the captured layout box for natural width/height (an inline svg has no bitmap 'natural' size)", () => {
    const evidence = interpretDomSnapshot(svgSnapshot({ rect: { x: 0, y: 0, width: 32, height: 18.6 } }));
    expect(evidence.image!.naturalWidth).toBe(32);
    expect(evidence.image!.naturalHeight).toBe(19); // rounded
  });

  it("alt is null (no equivalent to an <img alt> attribute for an inline svg)", () => {
    const evidence = interpretDomSnapshot(svgSnapshot());
    expect(evidence.image!.alt).toBeNull();
  });

  it("is null for a plain element with no svgMarkup", () => {
    const evidence = interpretDomSnapshot(svgSnapshot({ tag: "div", svgMarkup: null }));
    expect(evidence.image).toBeNull();
  });

  it("does not confuse svgMarkup on a non-svg tag with an actual svg icon (defensive — should never happen from a real capture)", () => {
    const evidence = interpretDomSnapshot(svgSnapshot({ tag: "div" }));
    expect(evidence.image).toBeNull();
  });
});

describe("interpretDomSnapshot — display:contents elements never become their own node (docs/adr/0033)", () => {
  function elWithDisplay(display: string, overrides: Partial<RawDomSnapshot> = {}): RawDomSnapshot {
    const computedStyle: Record<string, string> = {};
    for (const prop of COMPUTED_STYLE_PROPERTIES) computedStyle[prop] = "";
    computedStyle["display"] = display;
    return {
      tag: "div",
      attributes: {},
      textContent: null,
      rect: { x: 0, y: 0, width: 100, height: 40 },
      computedStyle,
      naturalWidth: null,
      naturalHeight: null,
      svgMarkup: null,
      componentPath: null,
      children: [],
      ...overrides,
    };
  }

  it("a display:contents child is skipped entirely — its own children are spliced into its parent's children, at its position", () => {
    const leaf1 = elWithDisplay("block", { attributes: { className: "leaf1" }, rect: { x: 10, y: 10, width: 20, height: 20 } });
    const leaf2 = elWithDisplay("block", { attributes: { className: "leaf2" }, rect: { x: 40, y: 10, width: 20, height: 20 } });
    const wrapper = elWithDisplay("contents", { attributes: { className: "u-display-contents" }, children: [leaf1, leaf2] });
    const before = elWithDisplay("block", { attributes: { className: "before" } });
    const after = elWithDisplay("block", { attributes: { className: "after" } });
    const root = elWithDisplay("flex", { attributes: { className: "root" }, children: [before, wrapper, after] });

    const evidence = interpretDomSnapshot(root);
    // 4 children — "before", leaf1, leaf2, "after" — NOT 3 (before, wrapper, after).
    expect(evidence.children.map((c) => c.attributes.className)).toEqual(["before", "leaf1", "leaf2", "after"]);
  });

  it("a chain of nested display:contents wrappers all get skipped, recursively", () => {
    const leaf = elWithDisplay("block", { attributes: { className: "real-leaf" } });
    const innerWrapper = elWithDisplay("contents", { attributes: { className: "inner" }, children: [leaf] });
    const outerWrapper = elWithDisplay("contents", { attributes: { className: "outer" }, children: [innerWrapper] });
    const root = elWithDisplay("block", { attributes: { className: "root" }, children: [outerWrapper] });

    const evidence = interpretDomSnapshot(root);
    expect(evidence.children).toHaveLength(1);
    expect(evidence.children[0].attributes.className).toBe("real-leaf");
  });

  it("an empty display:contents wrapper (no children) simply contributes nothing", () => {
    const wrapper = elWithDisplay("contents", { attributes: { className: "empty-wrapper" }, children: [] });
    const sibling = elWithDisplay("block", { attributes: { className: "sibling" } });
    const root = elWithDisplay("block", { attributes: { className: "root" }, children: [wrapper, sibling] });

    const evidence = interpretDomSnapshot(root);
    expect(evidence.children).toHaveLength(1);
    expect(evidence.children[0].attributes.className).toBe("sibling");
  });

  it("real-world reproduction: a flex row containing a display:contents wrapper around several real buttons — no degenerate {0,0,0,0} node reaches ElementEvidence at all", () => {
    // Mirrors the actual reported shape (docs/adr/0033): a captured
    // <div style="display:contents"> wrapping several real, visible
    // buttons, itself a child of a flex row. Its own captured rect is
    // degenerate (browsers report {0,0,0,0} for a display:contents
    // element's own box, since it generates none) — exactly the shape
    // that broke both the Figma import (ADR 0031, worked around via
    // Auto Layout ABSOLUTE) and, more fundamentally, HTML flexbox export
    // (ADR 0032's own relative-position math had no valid reference
    // point to use).
    const button1 = elWithDisplay("flex", { attributes: { className: "tab_btn_wrap" }, rect: { x: 177, y: 408, width: 88, height: 40 } });
    const button2 = elWithDisplay("flex", { attributes: { className: "tab_btn_wrap" }, rect: { x: 265, y: 408, width: 89, height: 40 } });
    const wrapper = elWithDisplay("contents", {
      attributes: { className: "u-display-contents" },
      rect: { x: 0, y: 0, width: 0, height: 0 },
      children: [button1, button2],
    });
    const menuInner = elWithDisplay("flex", { attributes: { className: "tab_menu_inner" }, rect: { x: 173, y: 404, width: 579, height: 48 }, children: [wrapper] });

    const evidence = interpretDomSnapshot(menuInner);
    expect(evidence.children).toHaveLength(2);
    expect(evidence.children.every((c) => c.attributes.className === "tab_btn_wrap")).toBe(true);
    expect(evidence.children.map((c) => c.bounds)).toEqual([
      { x: 177, y: 408, width: 88, height: 40 },
      { x: 265, y: 408, width: 89, height: 40 },
    ]);
  });
});