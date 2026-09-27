import type { ComponentDef, ComponentSet, CornerRadius, DesignDocument, Effect, Node } from "@reactfig/core";
import { cssColor, firstSolidFill, resolveRoot, type ResolvedNode } from "./resolveTree.js";

export interface SvgExportOptions {
  /** Which root to render when the document's first component is a ComponentSet (a family of variants) — defaults to its first variant. */
  variantId?: string;
}

export interface SvgExportResult {
  svg: string;
  width: number;
  height: number;
}

function pickRoot(doc: DesignDocument, options: SvgExportOptions): Node {
  const comp = doc.components[0];
  if (!comp) throw new Error("renderSvg: document has no components — nothing to render");
  return rootFor(comp, options.variantId);
}

function rootFor(comp: ComponentDef | ComponentSet, variantId?: string): Node {
  if (comp.kind === "component") return comp.root;
  const variant = variantId ? comp.variants.find((v) => v.id === variantId) : comp.variants[0];
  if (!variant) throw new Error(`renderSvg: componentSet "${comp.name}" has no variants to render`);
  return variant.root;
}

function radiusAttr(r: CornerRadius | undefined): { rx?: number } {
  if (r === undefined) return {};
  return { rx: Array.isArray(r) ? Math.max(...r) : r };
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Only `dropShadow`/`innerShadow` effects are renderable as an SVG
 * `<filter>` (blur/layerBlur effects are skipped — no dependency-free,
 * deterministic way to reproduce a Gaussian background-blur composite in
 * plain SVG without a backdrop reference, and it's rare enough on real
 * UI to not be worth the complexity for v1). Collects one `<filter>` def
 * per node that needs one (keyed by node id, so ids stay stable/
 * deterministic across renders) rather than inlining `<feDropShadow>`
 * per-shape, since a filter with multiple shadow effects needs to
 * `<feMerge>` them together in one place.
 */
function collectFilterDef(nodeId: string, effects: Effect[] | undefined): { filterId: string; def: string } | null {
  const shadows = (effects ?? []).filter(
    (e): e is Extract<Effect, { type: "dropShadow" | "innerShadow" }> => e.type === "dropShadow" || e.type === "innerShadow"
  );
  if (shadows.length === 0) return null;
  const filterId = `shadow_${nodeId}`;
  const primitives = shadows
    .map((shadow, i) => {
      const color = cssColor(shadow.color);
      // innerShadow has no direct feDropShadow equivalent; approximated
      // as a regular drop shadow too rather than silently dropped — an
      // outer glow reads much closer to "there's a shadow here" than
      // rendering nothing at all, even if not pixel-exact.
      return `<feDropShadow id="ds${i}" dx="${shadow.offsetX}" dy="${shadow.offsetY}" stdDeviation="${shadow.blur / 2}" flood-color="${color}"/>`;
    })
    .join("");
  return { filterId, def: `<filter id="${filterId}" x="-50%" y="-50%" width="200%" height="200%">${primitives}</filter>` };
}

function renderNode(resolved: ResolvedNode, doc: DesignDocument, filterDefs: string[]): string {
  const { node, bounds } = resolved;
  if (node.visible === false) return "";
  const opacity = node.opacity !== undefined && node.opacity !== 1 ? ` opacity="${node.opacity}"` : "";
  const effects = "effects" in node ? node.effects : undefined;
  const filter = collectFilterDef(node.id, effects);
  const filterAttr = filter ? ` filter="url(#${filter.filterId})"` : "";
  if (filter) filterDefs.push(filter.def);

  switch (node.type) {
    case "frame":
    case "shape": {
      const fill = firstSolidFill(node.fills);
      const stroke = node.strokes?.[0];
      const { rx } = radiusAttr(node.cornerRadius);
      const shapeTag = node.type === "shape" && node.shape === "ellipse" ? "ellipse" : "rect";
      const geom =
        shapeTag === "ellipse"
          ? `cx="${bounds.x + bounds.width / 2}" cy="${bounds.y + bounds.height / 2}" rx="${bounds.width / 2}" ry="${bounds.height / 2}"`
          : `x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}"${rx !== undefined ? ` rx="${rx}"` : ""}`;
      const fillAttr = fill ? `fill="${cssColor(fill)}"` : `fill="none"`;
      const strokeAttr = stroke ? ` stroke="${cssColor(stroke.color)}" stroke-width="${stroke.width}"` : "";
      const children = node.type === "frame" ? resolved.children.map((c) => renderNode(c, doc, filterDefs)).join("") : "";
      return `<${shapeTag} ${geom} ${fillAttr}${strokeAttr}${opacity}${filterAttr}/>${children ? `<g>${children}</g>` : ""}`;
    }
    case "group": {
      return `<g${opacity}${filterAttr}>${resolved.children.map((c) => renderNode(c, doc, filterDefs)).join("")}</g>`;
    }
    case "text": {
      const fill = firstSolidFill(node.fills);
      const t = node.typography;
      const style = t.italic ? ` font-style="italic"` : "";
      const anchor = t.textAlign === "center" ? "middle" : t.textAlign === "right" ? "end" : "start";
      const x = anchor === "middle" ? bounds.x + bounds.width / 2 : anchor === "end" ? bounds.x + bounds.width : bounds.x;
      // Baseline approximation: no real text-metrics engine here (a
      // deterministic, dependency-free SVG export) — vertically centers
      // using font-size as a stand-in for line height when none is given.
      const lineHeight = typeof t.lineHeight === "number" ? t.lineHeight : t.fontSize * 1.2;
      const y = bounds.y + lineHeight * 0.8;
      return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${escapeXml(t.fontFamily)}" font-size="${t.fontSize}" font-weight="${t.fontWeight}"${style} fill="${fill ? cssColor(fill) : "#000000"}"${opacity}${filterAttr}>${escapeXml(node.characters)}</text>`;
    }
    case "image": {
      const asset = doc.assets.find((a) => a.id === node.assetId);
      const href = asset?.path ?? "";
      return `<image x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" href="${escapeXml(href)}" preserveAspectRatio="xMidYMid slice"${opacity}${filterAttr}/>`;
    }
    case "instance": {
      // The instance node itself is not drawn — its resolved child (the
      // expanded referenced component/variant, see resolveTree.ts) is.
      return resolved.children.map((c) => renderNode(c, doc, filterDefs)).join("");
    }
  }
}

/**
 * Renders a Design IR document's root component (or a chosen variant of
 * its root ComponentSet) to a single static SVG document. Visual export
 * only — see docs section 9: SVG cannot represent component/instance
 * semantics, only their resolved geometry/fills/strokes/text, so instance
 * nodes are expanded inline rather than referenced.
 */
export function renderSvg(doc: DesignDocument, options: SvgExportOptions = {}): SvgExportResult {
  const rootNode = pickRoot(doc, options);
  const resolved = resolveRoot(doc, rootNode);
  const width = rootNode.bounds.width;
  const height = rootNode.bounds.height;
  const filterDefs: string[] = [];
  const body = renderNode(resolved, doc, filterDefs);
  const defs = filterDefs.length > 0 ? `<defs>${filterDefs.join("")}</defs>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${defs}${body}</svg>`;
  return { svg, width, height };
}
