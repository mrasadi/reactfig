/// <reference types="@figma/plugin-typings" />
import type { Bounds, Node as IRNode, InstanceOverride as DesignIrInstanceOverride } from "@reactfig/core";
import type { RenderContext } from "./types.js";
import { placeInParent, safeSize } from "./geometry.js";
import { applyFills, applyStrokes, applyCornerRadius, applyEffects, applyOpacity, type MinimalFillNode, type MinimalStrokeNode } from "./style.js";
import { applyLayout } from "./layout.js";
import { loadFontForText, applyTypography, mapFontStyle } from "./typography.js";
import { createImagePaintOrNull, createSvgNode, placeholderFill } from "./assets.js";

/**
 * Renders one IR node into `container` (already appended/parented — see
 * each branch) at a position relative to `parentBounds`. This is the
 * single dispatcher every node type — including a component's own
 * children (components.ts) and top-level page content (renderDocument.ts)
 * — goes through, so mapping logic is defined exactly once.
 */
export async function renderNode(node: IRNode, parentBounds: Bounds, container: FrameNode | ComponentNode | PageNode, ctx: RenderContext): Promise<SceneNode> {
  switch (node.type) {
    case "frame":
      return renderFrame(node, parentBounds, container, ctx);
    case "group":
      return renderGroup(node, parentBounds, container, ctx);
    case "text":
      return renderText(node, parentBounds, container, ctx);
    case "shape":
      return renderShape(node, parentBounds, container, ctx);
    case "image":
      return renderImage(node, parentBounds, container, ctx);
    case "instance":
      return renderInstance(node, parentBounds, container, ctx);
  }
}

/** Renders every child of a frame-like container, applying stretch to each if the parent's layout requested it (layoutAlign can only be set once a child exists — see layout.ts). */
export async function renderChildrenInto(
  children: IRNode[],
  parentBounds: Bounds,
  container: FrameNode | ComponentNode,
  ctx: RenderContext,
  stretchChildren: boolean
): Promise<void> {
  for (const child of children) {
    const childNode = await renderNode(child, parentBounds, container, ctx);
    // A child placeInParent (geometry.ts) marked layoutPositioning:
    // "ABSOLUTE" (see docs/adr/0031) no longer participates in the auto-
    // layout flow at all — layoutAlign:"STRETCH" governs cross-axis
    // sizing WITHIN that flow, so setting it on an ABSOLUTE child would be
    // a meaningless no-op at best; skipped for clarity rather than relying
    // on Figma to silently ignore it.
    const isAbsolute = "layoutPositioning" in childNode && (childNode as SceneNode & { layoutPositioning: string }).layoutPositioning === "ABSOLUTE";
    if (stretchChildren && !isAbsolute && "layoutAlign" in childNode) {
      (childNode as SceneNode & { layoutAlign: string }).layoutAlign = "STRETCH";
    }
  }
}

async function renderFrame(
  node: Extract<IRNode, { type: "frame" }>,
  parentBounds: Bounds,
  container: FrameNode | ComponentNode | PageNode,
  ctx: RenderContext
): Promise<FrameNode> {
  const context = `Frame "${node.name}"`;
  const frame = ctx.figmaApi.createFrame();
  container.appendChild(frame);
  frame.name = node.name;
  const size = safeSize(node.bounds);
  frame.resize(size.width, size.height);
  placeInParent(frame, node.bounds, parentBounds, container);
  // Figma frames clip their contents by default (unlike groups) — see
  // docs/adr/0031. design-ir/v1's `clipsContent` reflects what the real
  // page actually did (CSS `overflow` computed at capture time); an
  // absent/false value means content was allowed to overflow, which must
  // be preserved rather than silently defaulting to Figma's own
  // clip-on-create behavior — especially for a frame resized down to
  // `safeSize`'s minimal 0.01×0.01 floor (a degenerate captured bounds,
  // e.g. a `display:contents` wrapper), where a default clip would hide
  // every real, correctly-positioned child nested inside it entirely.
  frame.clipsContent = node.clipsContent ?? false;

  applyOpacity(frame, node.opacity);
  applyFills(frame, node.fills, ctx, context);
  applyStrokes(frame, node.strokes, ctx, context, node.strokeWeights);
  applyCornerRadius(frame, node.cornerRadius);
  applyEffects(frame, node.effects);

  const { stretchChildren } = applyLayout(frame, node.layout);
  await renderChildrenInto(node.children, node.bounds, frame, ctx, stretchChildren);
  return frame;
}

async function renderGroup(
  node: Extract<IRNode, { type: "group" }>,
  parentBounds: Bounds,
  container: FrameNode | ComponentNode | PageNode,
  ctx: RenderContext
): Promise<SceneNode> {
  if (node.children.length === 0) {
    ctx.warnings.push(`Group "${node.name}" has no children — Figma does not support empty groups; rendered as an empty frame instead.`);
    const frame = ctx.figmaApi.createFrame();
    container.appendChild(frame);
    frame.name = node.name;
    const size = safeSize(node.bounds);
    frame.resize(size.width, size.height);
    placeInParent(frame, node.bounds, parentBounds, container);
    applyOpacity(frame, node.opacity);
    return frame;
  }

  const childNodes: SceneNode[] = [];
  for (const child of node.children) {
    childNodes.push(await renderNode(child, parentBounds, container, ctx));
  }
  const group = ctx.figmaApi.group(childNodes, container);
  group.name = node.name;
  // The group's own position is implicit (Figma computes it as the union
  // of its children's bounds) — nothing to set via placeInParent — but if
  // `container` is an Auto Layout frame, the newly-created group is still
  // a fresh child of it and needs the same flow opt-out its own children
  // already got individually, or Figma's layout engine would reposition
  // the group itself (moving it away from where its already-correctly-
  // placed children visually are) — see docs/adr/0031.
  if ("layoutMode" in container && container.layoutMode !== "NONE" && "layoutPositioning" in group) {
    group.layoutPositioning = "ABSOLUTE";
  }
  applyOpacity(group, node.opacity);
  return group;
}

async function renderText(
  node: Extract<IRNode, { type: "text" }>,
  parentBounds: Bounds,
  container: FrameNode | ComponentNode | PageNode,
  ctx: RenderContext
): Promise<TextNode> {
  const text = ctx.figmaApi.createText();
  container.appendChild(text);

  const desiredFont: FontName = { family: node.typography.fontFamily, style: mapFontStyle(node.typography.fontWeight, !!node.typography.italic) };
  const resolvedFont = await loadFontForText(desiredFont, ctx);
  text.fontName = resolvedFont;
  text.characters = node.characters;
  text.name = node.name;
  const size = safeSize(node.bounds);
  applyTypography(text, node.typography, size.width);

  placeInParent(text, node.bounds, parentBounds, container);
  applyOpacity(text, node.opacity);
  applyFills(text, node.fills, ctx, `Text "${node.name}"`);
  return text;
}

async function renderShape(
  node: Extract<IRNode, { type: "shape" }>,
  parentBounds: Bounds,
  container: FrameNode | ComponentNode | PageNode,
  ctx: RenderContext
): Promise<RectangleNode | EllipseNode> {
  const context = `Shape "${node.name}"`;
  const shape = node.shape === "ellipse" ? ctx.figmaApi.createEllipse() : ctx.figmaApi.createRectangle();
  container.appendChild(shape);
  shape.name = node.name;
  const size = safeSize(node.bounds);
  shape.resize(size.width, size.height);
  placeInParent(shape, node.bounds, parentBounds, container);

  applyOpacity(shape, node.opacity);
  applyFills(shape, node.fills, ctx, context);
  applyStrokes(shape, node.strokes, ctx, context);
  if (node.shape === "rectangle") applyCornerRadius(shape as RectangleNode, node.cornerRadius);
  applyEffects(shape, node.effects);
  return shape;
}

async function renderImage(
  node: Extract<IRNode, { type: "image" }>,
  parentBounds: Bounds,
  container: FrameNode | ComponentNode | PageNode,
  ctx: RenderContext
): Promise<SceneNode> {
  const context = `Image "${node.name}"`;
  const mimeType = ctx.assetMimeTypes[node.assetId];

  if (mimeType === "image/svg+xml") {
    const svgNode = createSvgNode(node.assetId, ctx, context);
    if (svgNode) {
      container.appendChild(svgNode);
      svgNode.name = node.name;
      const size = safeSize(node.bounds);
      svgNode.resize(size.width, size.height);
      placeInParent(svgNode, node.bounds, parentBounds, container);
      applyOpacity(svgNode, node.opacity);
      return svgNode;
    }
    // fall through to the placeholder-rectangle path below if the SVG bytes weren't embedded
  }

  const rect = ctx.figmaApi.createRectangle();
  container.appendChild(rect);
  const size = safeSize(node.bounds);
  rect.resize(size.width, size.height);
  placeInParent(rect, node.bounds, parentBounds, container);
  applyOpacity(rect, node.opacity);

  const paint = createImagePaintOrNull(node.assetId, undefined, ctx, context);
  rect.fills = [paint ?? placeholderFill()];
  rect.name = paint ? node.name : `⚠ Missing asset: ${node.name}`;
  applyCornerRadius(rect, node.cornerRadius);
  applyEffects(rect, node.effects);
  return rect;
}

async function renderInstance(
  node: Extract<IRNode, { type: "instance" }>,
  parentBounds: Bounds,
  container: FrameNode | ComponentNode | PageNode,
  ctx: RenderContext
): Promise<SceneNode> {
  const key = node.componentRef.kind === "component" ? node.componentRef.componentId : `${node.componentRef.componentSetId}:${node.componentRef.variantId}`;
  const componentNode = ctx.componentIndex.get(key);
  const size = safeSize(node.bounds);

  let result: SceneNode;
  if (!componentNode) {
    ctx.warnings.push(`Instance "${node.name}" references component "${key}", which is not defined in this artifact — rendered as a placeholder frame.`);
    const placeholder = ctx.figmaApi.createFrame();
    container.appendChild(placeholder);
    placeholder.name = `⚠ Missing component: ${node.name}`;
    placeholder.resize(size.width, size.height);
    placeholder.fills = [placeholderFill()];
    result = placeholder;
  } else {
    const instance = componentNode.createInstance();
    container.appendChild(instance);
    instance.name = node.name;
    instance.resize(size.width, size.height);
    rescaleFullyRoundedCorners(componentNode, instance, size);
    await applyInstanceOverrides(instance, node.overrides, ctx, `Instance "${node.name}"`);
    result = instance;
  }

  placeInParent(result, node.bounds, parentBounds, container);
  applyOpacity(result, node.opacity);
  return result;
}

/**
 * Applies each `InstanceOverride` (see @reactfig/core's types.ts doc
 * comment) to the just-created Figma InstanceNode — the mechanism that
 * lets two instances of the same component show different data (e.g. two
 * StatCards, or the "completed"/"scheduled"/"missed" Badge nested inside
 * three different SessionCards) instead of both rendering whatever the
 * component was captured with.
 *
 * `path` is walked as a flat sequence of `.children[i]` lookups against
 * the real Figma instance tree. This deliberately does no special-casing
 * for a path that happens to cross into a nested instance (e.g. reaching
 * into a Badge instance nested inside a SessionCard instance) — Figma
 * already mirrors a nested instance's master content onto its own
 * `.children`, so the walk is transparent to the crossing. See the
 * `InstanceOverride.path` doc comment for how `path` is computed against
 * the Design IR to match this at authoring time.
 */
async function applyInstanceOverrides(
  instance: InstanceNode,
  overrides: DesignIrInstanceOverride[] | undefined,
  ctx: RenderContext,
  context: string
): Promise<void> {
  for (const override of overrides ?? []) {
    let target: SceneNode = instance;
    let ok = true;
    for (const idx of override.path) {
      if (!("children" in target)) {
        ok = false;
        break;
      }
      const next: SceneNode | undefined = (target as unknown as ChildrenMixin).children[idx];
      if (!next) {
        ok = false;
        break;
      }
      target = next;
    }
    if (!ok) {
      ctx.warnings.push(`${context}: override path [${override.path.join(", ")}] does not resolve to a node — skipped.`);
      continue;
    }
    if (override.characters !== undefined) {
      if (target.type !== "TEXT") {
        ctx.warnings.push(`${context}: override path [${override.path.join(", ")}] targets a non-text node — "characters" override skipped.`);
      } else {
        const font = await loadFontForText(target.fontName as FontName, ctx);
        target.fontName = font;
        target.characters = override.characters;
      }
    }
    if (override.fills) applyFills(target as MinimalFillNode, override.fills, ctx, `${context} override target`);
    if (override.strokes) applyStrokes(target as MinimalStrokeNode, override.strokes, ctx, `${context} override target`);
  }
}

/**
 * Figma doesn't rescale `cornerRadius` when an instance is resized to
 * different bounds than its master — it's an absolute px value inherited
 * as-is. For most components that's exactly right: an 8px card corner
 * really is meant to stay 8px regardless of instance size. But a corner
 * radius the master already maxed out to (>= half its own smaller
 * dimension — the standard `border-radius: 50%` circular/pill pattern,
 * e.g. a captured 32×32 avatar with cornerRadius 16) is a *shape*
 * statement, not a fixed measurement, and needs the same treatment at
 * every differently-sized instance to still read as a circle/pill instead
 * of turning into a merely-rounded rectangle the moment the instance is a
 * different size than whichever one usage happened to be captured (e.g. a
 * 48×48 usage elsewhere reusing a 32×32-captured Avatar's cornerRadius:16
 * unchanged, which only rounds a quarter of the way there on the bigger
 * box). Ordinary, non-maxed radii are left untouched.
 */
function rescaleFullyRoundedCorners(master: ComponentNode, instance: InstanceNode, size: { width: number; height: number }): void {
  const masterRadius = master.cornerRadius;
  if (typeof masterRadius !== "number" || masterRadius <= 0) return; // unset, zero, or figma.mixed (independent per-corner values already) — nothing to rescale
  if (master.width <= 0 || master.height <= 0) return;

  const masterMaxRadius = Math.min(master.width, master.height) / 2;
  const EPSILON = 0.5; // captured px values can carry sub-pixel rounding noise from the browser measurement
  const isFullyRounded = masterRadius >= masterMaxRadius - EPSILON;
  if (!isFullyRounded) return;

  instance.cornerRadius = Math.min(size.width, size.height) / 2;
}
