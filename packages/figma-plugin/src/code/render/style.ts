/// <reference types="@figma/plugin-typings" />
import type { Color, CornerRadius, Effect, Fill, Stroke, StrokeWeights, TokenOr } from "@reactfig/core";
import type { RenderContext } from "./types.js";
import { createImagePaintOrNull } from "./assets.js";

/** design-ir/v1 has no token-resolution system in v1 (ADR 0005) — a TokenRef can't be turned into a real color yet. Warns once per call site rather than silently dropping to black/transparent. */
function resolveColor(color: TokenOr<Color>, ctx: RenderContext, context: string): Color | null {
  if ("token" in color) {
    ctx.warnings.push(`${context}: color references token "${color.token}", which design-ir/v1 cannot resolve — skipped.`);
    return null;
  }
  return color;
}

export function buildFill(fill: Fill, ctx: RenderContext, context: string): Paint | null {
  if (fill.type === "solid") {
    const color = resolveColor(fill.color, ctx, context);
    if (!color) return null;
    return { type: "SOLID", color: { r: color.r, g: color.g, b: color.b }, opacity: color.a };
  }
  if (fill.type === "image") {
    return createImagePaintOrNull(fill.assetId, fill.scaleMode, ctx, context);
  }
  if (fill.type === "radialGradient") {
    return {
      type: "GRADIENT_RADIAL",
      gradientStops: fill.stops.map((stop) => ({
        position: stop.position,
        color: { r: stop.color.r, g: stop.color.g, b: stop.color.b, a: stop.color.a },
      })),
      gradientTransform: centerToGradientTransform(fill.centerX, fill.centerY),
    };
  }
  if (fill.type === "conicGradient") {
    return {
      type: "GRADIENT_ANGULAR",
      gradientStops: fill.stops.map((stop) => ({
        position: stop.position,
        color: { r: stop.color.r, g: stop.color.g, b: stop.color.b, a: stop.color.a },
      })),
      gradientTransform: conicGradientTransform(fill.centerX, fill.centerY, fill.startAngleDeg),
    };
  }
  // linearGradient
  return {
    type: "GRADIENT_LINEAR",
    gradientStops: fill.stops.map((stop) => ({
      position: stop.position,
      color: { r: stop.color.r, g: stop.color.g, b: stop.color.b, a: stop.color.a },
    })),
    gradientTransform: angleToGradientTransform(fill.angleDeg),
  };
}

/**
 * Figma's radial gradientTransform maps the unit circle centered at
 * (0.5, 0.5) with radius 0.5 (in node-space, 0–1) onto the node's actual
 * bounding box. design-ir/v1's `radialGradient` only carries a center
 * position (no per-axis radius — see parseRadialGradient.ts), so this is
 * a pure translation of that default circle's center, radius left
 * unchanged — same "approximate, not pixel-verified" status as
 * `angleToGradientTransform` below.
 */
function centerToGradientTransform(centerX: number, centerY: number): Transform {
  return [
    [1, 0, centerX - 0.5],
    [0, 1, centerY - 0.5],
  ];
}

/**
 * Figma's angular (conic) gradientTransform, like linear's, rotates
 * around the node's own center (0.5, 0.5) — this combines that same
 * rotation (reusing `angleToGradientTransform`'s cos/sin formula) with a
 * translation to an off-center position, the same way
 * `centerToGradientTransform` is `angleToGradientTransform`'s
 * zero-rotation special case. Approximate, same "not pixel-verified"
 * status as both of those.
 */
function conicGradientTransform(centerX: number, centerY: number, startAngleDeg: number): Transform {
  const rad = (startAngleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [
    [cos, -sin, centerX - 0.5 * cos + 0.5 * sin],
    [sin, cos, centerY - 0.5 * sin - 0.5 * cos],
  ];
}

/**
 * Standard angle→2x3-affine-matrix conversion for Figma's gradientTransform.
 * Approximate per docs/figma-plugin/feasibility.md ("fills (linearGradient)"
 * row) — not pixel-verified against real Figma rendering in this environment.
 */
function angleToGradientTransform(angleDeg: number): Transform {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [
    [cos, -sin, 0.5 - 0.5 * cos + 0.5 * sin],
    [sin, cos, 0.5 - 0.5 * sin - 0.5 * cos],
  ];
}

export function applyFills(node: MinimalFillNode, fills: Fill[] | undefined, ctx: RenderContext, context: string): void {
  if (!fills || fills.length === 0) return;
  const built = fills.map((f) => buildFill(f, ctx, context)).filter((p): p is Paint => p !== null);
  if (built.length > 0) node.fills = built;
}

export function applyStrokes(
  node: MinimalStrokeNode,
  strokes: Stroke[] | undefined,
  ctx: RenderContext,
  context: string,
  strokeWeights?: StrokeWeights
): void {
  if (!strokes || strokes.length === 0) return;
  const built: Paint[] = [];
  let maxWidth = 0;
  let dashed = false;
  for (const stroke of strokes) {
    const color = resolveColor(stroke.color, ctx, context);
    if (!color) continue;
    built.push({ type: "SOLID", color: { r: color.r, g: color.g, b: color.b }, opacity: color.a });
    maxWidth = Math.max(maxWidth, stroke.width);
    if (stroke.style === "dashed") dashed = true;
  }
  if (built.length === 0) return;
  node.strokes = built;
  node.strokeWeight = maxWidth;
  if (dashed) node.dashPattern = [4, 4];

  // Per-side widths (e.g. StatCard's border-left accent stripe: 1px on
  // three sides, 4px on the left) — Figma's individualStrokeWeights
  // mechanism. Only present on IR frames whose four sides actually
  // differed (see mapBorder in buildDesignIR.ts); a uniform border never
  // sets this, and node.strokeWeight above already covers it. Guarded by
  // a feature check since not every node type this function is called on
  // (e.g. a plain shape) supports individual stroke weights.
  if (strokeWeights && "strokeTopWeight" in node) {
    const sideWeightNode = node as MinimalStrokeNode & {
      strokeTopWeight: number;
      strokeRightWeight: number;
      strokeBottomWeight: number;
      strokeLeftWeight: number;
    };
    sideWeightNode.strokeTopWeight = strokeWeights.top;
    sideWeightNode.strokeRightWeight = strokeWeights.right;
    sideWeightNode.strokeBottomWeight = strokeWeights.bottom;
    sideWeightNode.strokeLeftWeight = strokeWeights.left;
  }
}

export function applyCornerRadius(node: MinimalCornerRadiusNode, cornerRadius: CornerRadius | undefined): void {
  if (cornerRadius === undefined) return;
  if (typeof cornerRadius === "number") {
    node.cornerRadius = cornerRadius;
    return;
  }
  const [topLeft, topRight, bottomRight, bottomLeft] = cornerRadius;
  node.topLeftRadius = topLeft;
  node.topRightRadius = topRight;
  node.bottomRightRadius = bottomRight;
  node.bottomLeftRadius = bottomLeft;
}

export function applyEffects(node: MinimalEffectsNode, effects: Effect[] | undefined): void {
  if (!effects || effects.length === 0) return;
  const built = effects.map((effect) => {
    if (effect.type === "layerBlur" || effect.type === "backgroundBlur") {
      return { type: effect.type === "layerBlur" ? "LAYER_BLUR" : "BACKGROUND_BLUR", radius: effect.radius, visible: true };
    }
    const shadow = effect as Extract<Effect, { type: "dropShadow" | "innerShadow" }>;
    return {
      type: shadow.type === "dropShadow" ? "DROP_SHADOW" : "INNER_SHADOW",
      color: { r: shadow.color.r, g: shadow.color.g, b: shadow.color.b, a: shadow.color.a },
      offset: { x: shadow.offsetX, y: shadow.offsetY },
      radius: shadow.blur,
      spread: shadow.spread ?? 0,
      visible: true,
      blendMode: "NORMAL",
    };
  });
  node.effects = built;
}

export function applyOpacity(node: MinimalOpacityNode, opacity: number | undefined): void {
  if (opacity !== undefined) node.opacity = opacity;
}

// Minimal structural types instead of the full Figma node unions — this
// renderer only ever needs to WRITE these few fields on whatever concrete
// node type it's handed. The fields are typed loosely (not matching
// Figma's exact getter/setter unions, which include a `typeof figma.mixed`
// marker for multi-selection reads) deliberately: these are private
// internal plumbing types, not part of any public contract, and fighting
// Figma's mixed-value variance here would add complexity with no real
// safety benefit — the actual node objects passed at runtime are always
// freshly-created single nodes, never in a "mixed" state.
export type MinimalFillNode = { fills: unknown };
export type MinimalStrokeNode = { strokes: unknown; strokeWeight: unknown; dashPattern: unknown };
type MinimalCornerRadiusNode = {
  cornerRadius?: unknown;
  topLeftRadius?: unknown;
  topRightRadius?: unknown;
  bottomLeftRadius?: unknown;
  bottomRightRadius?: unknown;
};
type MinimalEffectsNode = { effects: unknown };
type MinimalOpacityNode = { opacity: unknown };
