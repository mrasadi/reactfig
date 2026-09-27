import type { Bounds, ComponentDef, ComponentSet, CornerRadius, DesignDocument, Effect, Layout, Node } from "@reactfig/core";
import { cssColor, firstSolidFill, resolveRoot, type ResolvedNode } from "./resolveTree.js";

export interface HtmlExportOptions {
  variantId?: string;
  /** Document <title>. Defaults to the Design IR document's own name. */
  title?: string;
}

export interface HtmlExportResult {
  html: string;
  width: number;
  height: number;
}

function pickRoot(doc: DesignDocument, options: HtmlExportOptions): Node {
  const comp = doc.components[0];
  if (!comp) throw new Error("renderHtml: document has no components — nothing to render");
  return rootFor(comp, options.variantId);
}

function rootFor(comp: ComponentDef | ComponentSet, variantId?: string): Node {
  if (comp.kind === "component") return comp.root;
  const variant = variantId ? comp.variants.find((v) => v.id === variantId) : comp.variants[0];
  if (!variant) throw new Error(`renderHtml: componentSet "${comp.name}" has no variants to render`);
  return variant.root;
}

function radiusCss(r: CornerRadius | undefined): string {
  if (r === undefined) return "";
  return `border-radius:${Array.isArray(r) ? r.map((v) => `${v}px`).join(" ") : `${r}px`};`;
}

/** `dropShadow`/`innerShadow` effects map onto CSS `box-shadow` almost directly (the `inset` keyword is the only difference) — unlike SVG, no `<filter>` indirection needed. `layerBlur`/`backgroundBlur` are skipped, same rationale as svg.ts's collectFilterDef. */
function boxShadowCss(effects: Effect[] | undefined): string {
  const shadows = (effects ?? []).filter(
    (e): e is Extract<Effect, { type: "dropShadow" | "innerShadow" }> => e.type === "dropShadow" || e.type === "innerShadow"
  );
  if (shadows.length === 0) return "";
  const value = shadows
    .map((s) => `${s.type === "innerShadow" ? "inset " : ""}${s.offsetX}px ${s.offsetY}px ${s.blur}px ${s.spread ?? 0}px ${cssColor(s.color)}`)
    .join(", ");
  return `box-shadow:${value};`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function flexDirectionCss(mode: Layout["mode"]): string {
  return mode === "vertical" ? "column" : "row";
}

function justifyContentCss(align: Layout["primaryAxisAlign"]): string {
  switch (align) {
    case "center":
      return "center";
    case "end":
      return "flex-end";
    case "spaceBetween":
      return "space-between";
    default:
      return "flex-start";
  }
}

function alignItemsCss(align: Layout["counterAxisAlign"]): string {
  switch (align) {
    case "center":
      return "center";
    case "end":
      return "flex-end";
    // CSS has a native "stretch" keyword at the container level — unlike
    // Figma (ADR 0031's mapCounterAlign / layoutAlign:"STRETCH"
    // workaround), no per-child property is needed here at all.
    case "stretch":
      return "stretch";
    default:
      return "flex-start";
  }
}

/**
 * `layout.mode !== "none"` becomes REAL CSS flexbox — not simulated with
 * more absolute-positioned boxes — so the browser's own flex algorithm
 * places children, the same "let the real engine own this axis" choice
 * ADR 0031 already made for Figma's Auto Layout. The container itself
 * keeps its captured, literal width/height (never "hug contents" —
 * `box-sizing:border-box`, set globally, see renderHtml's <style> block,
 * makes padding subtract from that explicit size rather than growing it,
 * matching what the real captured page almost always intended).
 */
function flexContainerCss(layout: Layout): string {
  let css = `display:flex;flex-direction:${flexDirectionCss(layout.mode)};justify-content:${justifyContentCss(layout.primaryAxisAlign)};align-items:${alignItemsCss(layout.counterAxisAlign)};`;
  if (layout.gap !== undefined) css += `gap:${layout.gap}px;`;
  if (layout.padding) css += `padding:${layout.padding.top}px ${layout.padding.right}px ${layout.padding.bottom}px ${layout.padding.left}px;`;
  if (layout.wrap) css += `flex-wrap:wrap;`;
  return css;
}

/**
 * How this node is placed — the actual fix (docs/adr/0032). Two modes:
 *
 * - A flex item (its parent is real CSS flexbox, see flexContainerCss):
 *   no `position`/`left`/`top` at all — the browser's flex algorithm
 *   places it. `flex-shrink:0` keeps it at its own captured size (Design
 *   IR bounds are a literal measurement, never a hint to shrink — the
 *   same principle ADR 0031 applies on the Figma side).
 * - Otherwise: `position:absolute`, with `left`/`top` computed relative
 *   to `positioningRef` — the IMMEDIATE parent's own bounds, NOT the
 *   single global export-root offset `resolveTree.ts`'s `bounds` are
 *   already expressed in. This is the actual bug this ADR fixes: CSS
 *   `position:absolute` is relative to the nearest POSITIONED ancestor,
 *   and every ancestor in this export is positioned — so using the
 *   global bounds directly at every nesting level made each level's
 *   offset compound on top of its parent's. `position:fixed` (a
 *   reported workaround) "worked" only because it ignores ALL ancestors
 *   and always measures from the viewport, which happens to line up
 *   with the global convention `resolveTree.ts` uses — but breaks the
 *   moment this HTML is embedded in anything with its own scroll
 *   position, and isn't a real reason to prefer it architecturally.
 */
function positionCss(bounds: Bounds, positioningRef: Bounds, isFlexItem: boolean): string {
  if (isFlexItem) return "flex-shrink:0;";
  return `position:absolute;left:${bounds.x - positioningRef.x}px;top:${bounds.y - positioningRef.y}px;`;
}

/**
 * Whether THIS node itself must become a positioned element (`relative`)
 * purely to serve as the correct reference frame for its OWN children's
 * `position:absolute` — never combined with `positionCss`'s own
 * `position:absolute` (a node can only have one `position` value; when
 * `positionCss` already emits `absolute`, that's already a valid
 * containing block, so this returns nothing in that case).
 */
function anchorForChildrenCss(isFlexItem: boolean, childrenAreFlexItems: boolean, hasChildren: boolean): string {
  if (!isFlexItem) return ""; // already position:absolute — already a valid containing block
  if (childrenAreFlexItems) return ""; // no non-flex descendants need a containing block from THIS node
  if (!hasChildren) return "";
  return "position:relative;";
}

function baseVisualStyle(node: Node): string {
  const opacity = node.opacity !== undefined && node.opacity !== 1 ? `opacity:${node.opacity};` : "";
  const visibility = node.visible === false ? "display:none;" : "";
  return `${opacity}${visibility}`;
}

/**
 * `positioningRef` is the GLOBAL (export-root-relative — see
 * resolveTree.ts) bounds of whichever ancestor is this node's actual CSS
 * positioning reference (only meaningful when `isFlexItem` is false).
 * `isFlexItem` is whether THIS node's parent placed it via real flexbox
 * rather than absolute positioning (see positionCss above).
 */
function renderNode(resolved: ResolvedNode, doc: DesignDocument, positioningRef: Bounds, isFlexItem: boolean): string {
  const { node, bounds } = resolved;
  const posCss = positionCss(bounds, positioningRef, isFlexItem);
  const sizeCss = `width:${bounds.width}px;height:${bounds.height}px;`;
  const visualCss = baseVisualStyle(node);

  switch (node.type) {
    case "frame": {
      const isFlexContainer = Boolean(node.layout && node.layout.mode !== "none");
      const fill = firstSolidFill(node.fills);
      const stroke = node.strokes?.[0];
      const anchorCss = anchorForChildrenCss(isFlexItem, isFlexContainer, resolved.children.length > 0);
      const style = `${posCss}${sizeCss}${visualCss}${anchorCss}${isFlexContainer ? flexContainerCss(node.layout!) : ""}${fill ? `background:${cssColor(fill)};` : ""}${stroke ? `border:${stroke.width}px ${stroke.style ?? "solid"} ${cssColor(stroke.color)};` : ""}${radiusCss(node.cornerRadius)}${node.clipsContent ? "overflow:hidden;" : ""}${boxShadowCss(node.effects)}`;
      const childRef = bounds; // this frame's own (global) bounds become the new relative-positioning reference for its children
      const children = resolved.children.map((c) => renderNode(c, doc, childRef, isFlexContainer)).join("");
      return `<div class="rfd-frame" data-name="${escapeHtml(node.name)}" style="${style}">${children}</div>`;
    }
    case "group": {
      // Groups have no `layout` at all (core/types.ts's GroupNode) — never a flex container, always a plain positioning context for their children, same as a layout:"none" frame.
      const anchorCss = anchorForChildrenCss(isFlexItem, false, resolved.children.length > 0);
      const childRef = bounds;
      const children = resolved.children.map((c) => renderNode(c, doc, childRef, false)).join("");
      return `<div class="rfd-group" data-name="${escapeHtml(node.name)}" style="${posCss}${sizeCss}${visualCss}${anchorCss}">${children}</div>`;
    }
    case "shape": {
      const fill = firstSolidFill(node.fills);
      const stroke = node.strokes?.[0];
      const shapeRadius = node.shape === "ellipse" ? "border-radius:50%;" : radiusCss(node.cornerRadius);
      const style = `${posCss}${sizeCss}${visualCss}${fill ? `background:${cssColor(fill)};` : ""}${stroke ? `border:${stroke.width}px solid ${cssColor(stroke.color)};` : ""}${shapeRadius}${boxShadowCss(node.effects)}`;
      return `<div class="rfd-shape" data-name="${escapeHtml(node.name)}" style="${style}"></div>`;
    }
    case "text": {
      const fill = firstSolidFill(node.fills);
      const t = node.typography;
      const lineHeight = typeof t.lineHeight === "number" ? `${t.lineHeight}px` : t.lineHeight ? `${t.lineHeight.value}%` : "normal";
      const style = `${posCss}${sizeCss}${visualCss}margin:0;font-family:${t.fontFamily},sans-serif;font-size:${t.fontSize}px;font-weight:${t.fontWeight};line-height:${lineHeight};text-align:${t.textAlign ?? "left"};${t.italic ? "font-style:italic;" : ""}${t.letterSpacing ? `letter-spacing:${t.letterSpacing}px;` : ""}color:${fill ? cssColor(fill) : "#000000"};`;
      return `<p class="rfd-text" style="${style}">${escapeHtml(node.characters)}</p>`;
    }
    case "image": {
      const asset = doc.assets.find((a) => a.id === node.assetId);
      const style = `${posCss}${sizeCss}${visualCss}object-fit:cover;${radiusCss(node.cornerRadius)}${boxShadowCss(node.effects)}`;
      return `<img class="rfd-image" data-name="${escapeHtml(node.name)}" src="${escapeHtml(asset?.path ?? "")}" style="${style}" alt="${escapeHtml(node.name)}"/>`;
    }
    case "instance": {
      // No wrapping element of its own (HTML has no native "component
      // instance" concept) — its one resolved child (see resolveTree.ts,
      // an instance always resolves to exactly one expanded child) is
      // spliced in as if the instance boundary weren't there at all, so
      // it inherits EXACTLY the positioning context (`positioningRef`/
      // `isFlexItem`) the instance itself would have used — correct
      // specifically because there's always exactly one such child, so
      // there's no flex-flow-atomicity concern from having "multiple
      // top-level children" suddenly appear in the parent's flow.
      return resolved.children.map((c) => renderNode(c, doc, positioningRef, isFlexItem)).join("");
    }
  }
}

/**
 * Renders a Design IR document's root component (or a chosen variant) to
 * a standalone HTML document, renderable independently of the original
 * React app (see docs section 10). Reconstructs REAL CSS flexbox for any
 * captured `layout.mode !== "none"` frame (docs/adr/0032) — the browser's
 * own flex algorithm places those children, not more absolute-positioned
 * boxes; a `layout.mode:"none"` frame (freely positioned content, or the
 * CSS Grid absolute-position fallback from ADR 0002) falls back to
 * `position:absolute`, computed correctly relative to its own immediate
 * parent rather than the single global export-root offset `resolveTree.ts`
 * expresses every node's raw `bounds` in.
 */
export function renderHtml(doc: DesignDocument, options: HtmlExportOptions = {}): HtmlExportResult {
  const rootNode = pickRoot(doc, options);
  const resolved = resolveRoot(doc, rootNode);
  const width = rootNode.bounds.width;
  const height = rootNode.bounds.height;
  // The root itself is always position:absolute at (0,0) within .rfd-root
  // (resolveRoot's own translation already puts its bounds at exactly
  // {x:0,y:0,...} — see resolveTree.ts) — not a flex item of anything, it
  // has no siblings.
  const body = renderNode(resolved, doc, resolved.bounds, false);
  const title = escapeHtml(options.title ?? doc.name);
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>${title}</title>
<style>*{box-sizing:border-box;} html,body{margin:0;padding:0;} .rfd-root{position:relative;width:${width}px;height:${height}px;overflow:hidden;}</style>
</head>
<body>
<div class="rfd-root">${body}</div>
</body>
</html>`;
  return { html, width, height };
}
