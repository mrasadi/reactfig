import type { RawDomSnapshot } from "../browser/rawTypes.js";
import { parseColor, parseCornerRadius, parseCssUrl, parsePx, classifyLayoutMode } from "./parse.js";
import type { ElementEvidence, FlexEvidence, GridEvidence, GridChildPlacementEvidence, StyleEvidence, BorderEvidence } from "./types.js";

function buildFlexEvidence(cs: Record<string, string>): FlexEvidence {
  return {
    direction: cs["flex-direction"] ?? null,
    justifyContent: cs["justify-content"] ?? null,
    alignItems: cs["align-items"] ?? null,
    wrap: cs["flex-wrap"] ?? null,
    gap: parsePx(cs["gap"]),
    rowGap: parsePx(cs["row-gap"]),
    columnGap: parsePx(cs["column-gap"]),
  };
}

function buildGridEvidence(cs: Record<string, string>): GridEvidence {
  return {
    templateColumns: cs["grid-template-columns"] ?? null,
    templateRows: cs["grid-template-rows"] ?? null,
    autoFlow: cs["grid-auto-flow"] ?? null,
    gap: parsePx(cs["gap"]),
    rowGap: parsePx(cs["row-gap"]),
    columnGap: parsePx(cs["column-gap"]),
  };
}

function buildGridChildPlacement(cs: Record<string, string>): GridChildPlacementEvidence | null {
  const column = cs["grid-column"] ?? null;
  const row = cs["grid-row"] ?? null;
  if (column === null && row === null) return null;
  // "auto" is CSS's default/unset value — not meaningful placement evidence.
  if ((column === null || column === "auto") && (row === null || row === "auto")) return null;
  return { column, row };
}

function buildStyleEvidence(cs: Record<string, string>, parentIsGrid: boolean, box: { width: number; height: number }): StyleEvidence {
  const display = cs["display"] ?? null;
  const layoutMode = classifyLayoutMode(display);

  const paddingTop = parsePx(cs["padding-top"]);
  const paddingRight = parsePx(cs["padding-right"]);
  const paddingBottom = parsePx(cs["padding-bottom"]);
  const paddingLeft = parsePx(cs["padding-left"]);
  const hasPadding = [paddingTop, paddingRight, paddingBottom, paddingLeft].some((v) => v !== null && v !== 0);

  const marginTop = parsePx(cs["margin-top"]);
  const marginRight = parsePx(cs["margin-right"]);
  const marginBottom = parsePx(cs["margin-bottom"]);
  const marginLeft = parsePx(cs["margin-left"]);
  const hasMargin = [marginTop, marginRight, marginBottom, marginLeft].some((v) => v !== null && v !== 0);

  const borderSide = (side: "top" | "right" | "bottom" | "left") => {
    const widthPx = parsePx(cs[`border-${side}-width`]);
    const style = cs[`border-${side}-style`] ?? null;
    const color = parseColor(cs[`border-${side}-color`]);
    if (widthPx === null || widthPx <= 0 || style === "none") return null;
    return { widthPx, style, color };
  };
  const border: BorderEvidence = { top: borderSide("top"), right: borderSide("right"), bottom: borderSide("bottom"), left: borderSide("left") };
  const hasBorder = border.top !== null || border.right !== null || border.bottom !== null || border.left !== null;

  const zIndexRaw = cs["z-index"];
  const zIndex = zIndexRaw && zIndexRaw !== "auto" && !Number.isNaN(Number(zIndexRaw)) ? Number(zIndexRaw) : null;

  const cornerRadiusRaw = cs["border-radius"];
  // Resolved against this element's own box (needed for percentage
  // radii — see parseCornerRadius) — e.g. Avatar.css's `border-radius:
  // 50%`, the standard CSS pattern for a circular avatar. Without a box
  // size to resolve against, a percentage token was previously silently
  // dropped (parsePx only matches a bare "Npx" suffix), producing a
  // square avatar in Figma with no warning that anything had been lost.
  const cornerRadius = cornerRadiusRaw ? { raw: cornerRadiusRaw, parsedPx: parseCornerRadius(cornerRadiusRaw, box) } : null;

  const backgroundImage = cs["background-image"] && cs["background-image"] !== "none" ? cs["background-image"] : null;

  return {
    display,
    layoutMode,
    position: cs["position"] ?? null,
    zIndex,
    flex: layoutMode === "flex" ? buildFlexEvidence(cs) : null,
    grid: layoutMode === "grid" ? buildGridEvidence(cs) : null,
    gridChildPlacement: parentIsGrid ? buildGridChildPlacement(cs) : null,
    padding: hasPadding
      ? { top: paddingTop ?? 0, right: paddingRight ?? 0, bottom: paddingBottom ?? 0, left: paddingLeft ?? 0 }
      : null,
    margin: hasMargin
      ? { top: marginTop ?? 0, right: marginRight ?? 0, bottom: marginBottom ?? 0, left: marginLeft ?? 0 }
      : null,
    backgroundColor: parseColor(cs["background-color"]),
    backgroundImage,
    backgroundImageUrl: parseCssUrl(backgroundImage),
    border: hasBorder ? border : null,
    cornerRadius,
    boxShadow: cs["box-shadow"] && cs["box-shadow"] !== "none" ? cs["box-shadow"] : null,
    filter: cs["filter"] && cs["filter"] !== "none" ? cs["filter"] : null,
    backdropFilter: cs["backdrop-filter"] && cs["backdrop-filter"] !== "none" ? cs["backdrop-filter"] : null,
    opacity: cs["opacity"] !== undefined ? Number(cs["opacity"]) : null,
    overflow: cs["overflow"] ?? null,
    typography: {
      fontFamily: cs["font-family"] ?? null,
      fontSizePx: parsePx(cs["font-size"]),
      fontWeight: cs["font-weight"] ?? null,
      fontStyle: cs["font-style"] ?? null,
      lineHeight: cs["line-height"] ?? null,
      lineHeightPx: parsePx(cs["line-height"]),
      letterSpacing: cs["letter-spacing"] ?? null,
      letterSpacingPx: parsePx(cs["letter-spacing"]),
      textAlign: cs["text-align"] ?? null,
      whiteSpace: cs["white-space"] ?? null,
      textOverflow: cs["text-overflow"] ?? null,
      color: parseColor(cs["color"]),
    },
  };
}

function nearestOwner(path: string[] | null): string | null {
  return path && path.length > 0 ? path[path.length - 1] : null;
}

/**
 * `display: contents` (docs/adr/0033) makes an element generate NO box
 * of its own — only its children participate in layout/rendering, at
 * the position they'd have if the `display:contents` element weren't
 * there at all. A real capture still walks it (collectDomSnapshot.ts has
 * no reason to skip it — it's a perfectly normal DOM element otherwise),
 * which is exactly the problem: its own captured `rect` is degenerate
 * (`{x:0,y:0,width:0,height:0}` — there's no box to measure), and using
 * that as a reference point for ANYTHING (a Design IR frame's own bounds,
 * an exporter's relative-position math for its children) produces
 * meaningless results — not a rare edge case either: this exact shape is
 * what a real capture of google.com's own primary navigation used.
 *
 * Fixed at the SOURCE, not papered over per-exporter: a `display:
 * contents` element never becomes its own `ElementEvidence` node at
 * all — its children are spliced directly into its own parent's
 * children, recursively (in case of a `display:contents` chain),
 * exactly matching what the real CSS box tree already does. Every
 * downstream consumer (buildDesignIR.ts, every exporter) never sees the
 * degenerate wrapper, so nothing downstream needs to know this class of
 * element exists.
 */
function isDisplayContents(raw: RawDomSnapshot): boolean {
  return raw.computedStyle["display"] === "contents";
}

function expandDisplayContentsChildren(children: RawDomSnapshot[]): RawDomSnapshot[] {
  const result: RawDomSnapshot[] = [];
  for (const child of children) {
    if (isDisplayContents(child)) {
      result.push(...expandDisplayContentsChildren(child.children));
    } else {
      result.push(child);
    }
  }
  return result;
}

/**
 * Encodes captured inline `<svg>` markup as a `data:image/svg+xml;base64,`
 * URI so it can flow through the exact same `ImageAssetEvidence`/
 * `AssetRef`/image-node path an `<img src="https://...">` already uses
 * (docs/adr/0030) — no separate vector-asset plumbing needed anywhere
 * downstream (buildDesignIR.ts's registerAsset, pack()'s asset embedding,
 * the SVG/HTML exporters' `<image>`/`<img>` tags all already accept any
 * URI in `AssetRef.path`, `data:` included). Runs here, in Node
 * (interpretDomSnapshot.ts is not itself injected into the browser,
 * unlike collectDomSnapshot.ts — see that file's own doc comment) where
 * `Buffer` is available.
 */
function svgMarkupToDataUri(markup: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(markup, "utf-8").toString("base64")}`;
}

/**
 * Interprets one raw snapshot node into ElementEvidence. `parentIsGrid`
 * and `parentComponentPath` must be threaded down by the caller — a node
 * doesn't know its parent's display mode or component ownership from its
 * own computed style/fiber data alone.
 */
function interpretNode(raw: RawDomSnapshot, parentIsGrid: boolean, parentComponentPath: string[] | null): ElementEvidence {
  const style = buildStyleEvidence(raw.computedStyle, parentIsGrid, { width: raw.rect.width, height: raw.rect.height });
  const isGridParent = style.layoutMode === "grid";
  const image =
    raw.tag === "img" && raw.attributes.src
      ? {
          src: raw.attributes.src,
          naturalWidth: raw.naturalWidth,
          naturalHeight: raw.naturalHeight,
          alt: raw.attributes.alt ?? null,
        }
      : raw.tag === "svg" && raw.svgMarkup
        ? {
            src: svgMarkupToDataUri(raw.svgMarkup),
            // An inline <svg> has no "natural" bitmap size the way an
            // <img> does — its own captured layout box is the closest
            // equivalent, and is what mapImageNode (buildDesignIR.ts)
            // falls back to anyway when these are null, so this is
            // informational rather than load-bearing.
            naturalWidth: Math.round(raw.rect.width) || null,
            naturalHeight: Math.round(raw.rect.height) || null,
            alt: null,
          }
        : null;

  const componentPath = raw.componentPath;
  const isComponentRoot = componentPath !== null && nearestOwner(componentPath) !== nearestOwner(parentComponentPath);

  return {
    tag: raw.tag,
    attributes: {
      id: raw.attributes.id,
      className: raw.attributes.className,
      role: raw.attributes.role,
    },
    textContent: raw.textContent,
    bounds: raw.rect,
    style,
    image,
    componentPath,
    isComponentRoot,
    children: expandDisplayContentsChildren(raw.children).map((c) => interpretNode(c, isGridParent, componentPath)),
  };
}

/** Interprets a raw snapshot tree captured from the browser into ElementEvidence. Pure — no DOM access. */
export function interpretDomSnapshot(raw: RawDomSnapshot): ElementEvidence {
  // The selected ROOT itself being `display:contents` is an edge case
  // (the developer would have had nothing visible to click on to select
  // it in the first place — see the overlay's own boundary-resolution,
  // which operates on real rendered geometry) rather than something a
  // real capture produces at the top level; expandDisplayContentsChildren
  // above handles it correctly at every level BELOW the root, which is
  // where it actually occurs in practice.
  return interpretNode(raw, false, null);
}
