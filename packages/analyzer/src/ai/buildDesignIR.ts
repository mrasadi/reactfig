import type {
  AssetRef,
  Color,
  ComponentDef,
  ComponentSet,
  ComponentVariant,
  CornerRadius,
  DesignDocument,
  Effect,
  Fill,
  InstanceOverride,
  Layout,
  Node as IRNode,
  Stroke,
  StrokeWeights,
  Typography,
  VariantPropertyDef,
} from "@reactfig/core";
import type { BorderEvidence, BoundsEvidence, ColorEvidence, ComponentEvidence, ElementEvidence, PaddingEvidence, RenderCapture } from "../evidence/types.js";
import type { ComponentInterpretation, NodeAnnotation } from "./types.js";
import { parseBoxShadow } from "../evidence/parseBoxShadow.js";
import { parseBlur } from "../evidence/parseBlur.js";
import { parseLinearGradient, parseRadialGradient, parseConicGradient } from "../evidence/parseGradient.js";
import { splitTopLevel, parseCssUrl } from "../evidence/parse.js";
import { parseFontFamily } from "../evidence/parseFontFamily.js";

/**
 * Deterministic. Never calls a model. Pulls geometry, color, spacing, and
 * text directly from ComponentEvidence — `interpretation` only supplies
 * variant-axis confirmation, decorative-collapse decisions, and naming.
 * This function is the concrete mechanism behind "AI must not silently
 * overwrite deterministic facts" (docs/adr/0008-ai-orchestration.md).
 *
 * box-shadow and CSS linear-gradient backgrounds ARE translated into
 * structured `Effect`/`Fill` values (see parseBoxShadow.ts /
 * parseGradient.ts) — both are pure parses of evidence already captured
 * verbatim (ADR 0007), not fabricated structure. What's still
 * intentionally out of scope, documented rather than half-solved:
 *  - Nested component instances reference a synthesized placeholder
 *    componentId (`external:<Name>`) rather than a real ComponentDef,
 *    since resolving/including that component's own definition requires
 *    analyzing it separately — a Phase 5+/orchestration-level concern
 *    (though @reactfig/core's mergeDesignDocuments now resolves this
 *    once the dependency documents exist — see its own docs).
 *  - radial-gradient/conic-gradient, non-uniform per-side borders,
 *    CSS filter/backdrop-filter (blur), and multiple stacked
 *    background-image layers — see docs/adr/0008, "Known limitations",
 *    for the full current list and why each is deferred.
 */
export function buildDesignIR(evidence: ComponentEvidence, interpretation: ComponentInterpretation): DesignDocument {
  const ctx = new BuildContext(evidence.componentName);

  const variantCaptures = selectVariantCaptures(evidence, interpretation);
  const componentEntry: ComponentDef | ComponentSet =
    variantCaptures.length > 0
      ? buildComponentSet(evidence, interpretation, variantCaptures, ctx)
      : buildComponentDef(evidence, interpretation, ctx);

  const pageInstance = buildPageInstance(componentEntry, evidence);

  return {
    $schema: "https://reactfig.dev/schema/design-ir/v1.json",
    version: "design-ir/v1",
    id: `doc_${slug(evidence.componentName)}`,
    name: `${evidence.componentName} example`,
    meta: {
      generator: "@reactfig/analyzer ai-orchestration@0.1.0",
      generatedAt: new Date().toISOString(),
    },
    assets: ctx.assets,
    components: [componentEntry],
    pages: [{ id: "page_examples", name: "Examples", children: [pageInstance] }],
  };
}

// ---------------------------------------------------------------------------
// Variant selection — evidence-backed only, never fabricated
// ---------------------------------------------------------------------------

interface VariantCapture {
  capture: RenderCapture;
  propertyValues: Record<string, string>;
}

/**
 * Only captures whose propValues actually include every confirmed variant
 * axis are used. An axis confirmed by the model but never captured (e.g.
 * the source declares `variant: 'primary' | 'secondary'` but only
 * "primary" was ever rendered) produces zero variants for the
 * un-evidenced value — see docs/adr/0008, "Variants" — rather than a
 * fabricated one.
 *
 * A `state` axis (hover/focus/active — see RenderCapture.interactionState)
 * is handled separately from the model-confirmed `interpretation.variantAxes`
 * list, deliberately: which interaction was performed before a capture was
 * taken is something this code commanded and knows for certain, not
 * something that needs (or benefits from) AI confirmation the way "is this
 * prop actually a meaningful variant axis" does — see docs/adr/0023-
 * interaction-state-capture.md. It's added to the axis list whenever ANY
 * capture in this evidence has `interactionState` set, independent of
 * whether the model found any prop-driven axes at all; a capture with no
 * `interactionState` is treated as `state: "default"` once that axis is
 * active, so a plain default-props capture still lines up correctly
 * alongside a hover capture of the same instance.
 */
function selectVariantCaptures(evidence: ComponentEvidence, interpretation: ComponentInterpretation): VariantCapture[] {
  const hasInteractionAxis = evidence.captures.some((c) => c.interactionState !== undefined);
  const axisNames = interpretation.variantAxes.map((a) => a.propName);
  if (axisNames.length === 0 && !hasInteractionAxis) return [];

  const seen = new Set<string>();
  const results: VariantCapture[] = [];
  for (const capture of evidence.captures) {
    const propertyValues: Record<string, string> = {};
    let complete = true;

    if (axisNames.length > 0) {
      if (!capture.propValues) continue;
      for (const name of axisNames) {
        const value = capture.propValues[name];
        if (typeof value !== "string") {
          complete = false;
          break;
        }
        propertyValues[name] = value;
      }
      if (!complete) continue;
    }

    if (hasInteractionAxis) {
      propertyValues.state = capture.interactionState ?? "default";
    }

    const allAxisNames = hasInteractionAxis ? [...axisNames, "state"] : axisNames;
    const key = allAxisNames.map((n) => propertyValues[n]).join("|");
    if (seen.has(key)) continue; // first capture for a given combination wins
    seen.add(key);
    results.push({ capture, propertyValues });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Component assembly
// ---------------------------------------------------------------------------

function buildComponentDef(evidence: ComponentEvidence, interpretation: ComponentInterpretation, ctx: BuildContext): ComponentDef {
  const capture = evidence.captures.find((c) => !c.propValues) ?? evidence.captures[0];
  return {
    kind: "component",
    id: `comp_${slug(evidence.componentName)}`,
    name: interpretation.componentDisplayName || evidence.componentName,
    root: mapNode(capture.dom, [], interpretation, ctx),
    source: evidence.source.file ? { file: evidence.source.file, export: evidence.source.exportName } : undefined,
  };
}

function buildComponentSet(
  evidence: ComponentEvidence,
  interpretation: ComponentInterpretation,
  variantCaptures: VariantCapture[],
  ctx: BuildContext
): ComponentSet {
  const variantProperties: VariantPropertyDef[] = interpretation.variantAxes.map((axis) => ({
    name: axis.propName,
    values: [...new Set(variantCaptures.map((vc) => vc.propertyValues[axis.propName]).filter((v): v is string => v !== undefined))],
  }));
  // See selectVariantCaptures's doc comment — "state" is added
  // deterministically whenever any capture used it, independent of the
  // model-confirmed axes above.
  if (variantCaptures.some((vc) => vc.propertyValues.state !== undefined)) {
    variantProperties.push({
      name: "state",
      values: [...new Set(variantCaptures.map((vc) => vc.propertyValues.state).filter((v): v is string => v !== undefined))],
    });
  }

  const variants: ComponentVariant[] = variantCaptures.map((vc, i) => ({
    id: `comp_${slug(evidence.componentName)}_v${i}`,
    propertyValues: vc.propertyValues,
    root: mapNode(vc.capture.dom, [], interpretation, ctx),
    source: evidence.source.file ? { file: evidence.source.file, export: evidence.source.exportName, props: vc.propertyValues } : undefined,
  }));

  return {
    kind: "componentSet",
    id: `comp_${slug(evidence.componentName)}`,
    name: interpretation.componentDisplayName || evidence.componentName,
    variantProperties,
    variants,
    source: evidence.source.file ? { file: evidence.source.file, export: evidence.source.exportName } : undefined,
  };
}

function buildPageInstance(component: ComponentDef | ComponentSet, evidence: ComponentEvidence): IRNode {
  const bounds = evidence.captures[0]?.dom.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
  const componentRef: Extract<IRNode, { type: "instance" }>["componentRef"] =
    component.kind === "component"
      ? { kind: "component", componentId: component.id }
      : { kind: "variant", componentSetId: component.id, variantId: component.variants[0].id };

  return {
    type: "instance",
    id: `node_${slug(evidence.componentName)}_instance`,
    name: evidence.componentName,
    bounds,
    componentRef,
  };
}

// ---------------------------------------------------------------------------
// Node mapping — deterministic, evidence-first
// ---------------------------------------------------------------------------

class BuildContext {
  assets: AssetRef[] = [];
  private assetIndex = new Map<string, string>();
  private nodeCounter = 0;

  constructor(public readonly rootComponentName: string) {}

  nextNodeId(prefix: string): string {
    return `node_${prefix}_${this.nodeCounter++}`;
  }

  registerAsset(src: string, width: number | null, height: number | null): string {
    const existing = this.assetIndex.get(src);
    if (existing) return existing;
    const id = `asset_${this.assets.length}`;
    this.assetIndex.set(src, id);
    // path is the original evidence-captured URL/dev-server path, not yet
    // resolved to real bytes in an artifact's assets/ — that resolution is
    // a Phase 5 (artifact packaging) concern, not this function's.
    this.assets.push({ id, path: src, mimeType: guessMimeType(src), width: width ?? undefined, height: height ?? undefined });
    return id;
  }
}

function findAnnotation(annotations: NodeAnnotation[], path: number[]): NodeAnnotation | undefined {
  return annotations.find((a) => a.path.length === path.length && a.path.every((v, i) => v === path[i]));
}

function nearestOwner(path: string[] | null): string | null {
  return path && path.length > 0 ? path[path.length - 1] : null;
}

function mapNode(el: ElementEvidence, path: number[], interpretation: ComponentInterpretation, ctx: BuildContext): IRNode {
  const annotation = findAnnotation(interpretation.nodeAnnotations, path);

  // Decorative collapse: only safe to honor for a single-child pass-through wrapper.
  if (annotation?.semanticType === "skip" && el.children.length === 1) {
    return mapNode(el.children[0], [...path, 0], interpretation, ctx);
  }

  // Deterministic nested-component-boundary detection (no AI needed — see ADR 0007/0008).
  const owner = nearestOwner(el.componentPath);
  if (path.length > 0 && el.isComponentRoot && owner && owner !== ctx.rootComponentName) {
    return {
      type: "instance",
      id: ctx.nextNodeId("instance"),
      name: annotation?.semanticName ?? owner,
      bounds: el.bounds,
      componentRef: { kind: "component", componentId: `external:${owner}` },
      overrides: buildNestedInstanceOverrides(el),
    };
  }

  // A leaf element that's purely text — no meaningful box styling of its
  // own — maps directly to a text node. But a leaf element that ALSO
  // carries background/border/corner-radius (the extremely common
  // "pill"/"button" pattern: a single <span>/<button> that is both the
  // text and its own styled box, e.g. Badge's `<span class="badge">` or
  // Button's `<button>`) needs that box styling preserved — falling
  // through to mapFrameNode (which synthesizes a text child for exactly
  // this case) rather than mapTextNode, which only ever captures
  // typography + glyph color and would silently discard the
  // background/border/radius entirely. Without this check, a badge like
  // Badge.tsx's `<span class="badge badge-success">` (white text on a
  // green pill) rendered as bare white text with no pill at all —
  // readable in the DOM, invisible in Figma.
  if (el.children.length === 0 && el.textContent && !hasBoxStyling(el)) {
    return mapTextNode(el, annotation, ctx);
  }

  // <img> and an inline <svg> icon are both captured into the same
  // `el.image` shape (see interpretDomSnapshot.ts's svgMarkupToDataUri) —
  // Design IR has no separate vector/path node type, so an icon becomes
  // an image node too, docs/adr/0030.
  if (el.image) {
    return mapImageNode(el, annotation, ctx);
  }

  return mapFrameNode(el, path, annotation, interpretation, ctx);
}

/**
 * When mapNode crosses a nested-component boundary (e.g. a Badge rendered
 * inside SessionCard, an Avatar rendered inside Header), it deliberately
 * replaces the whole subtree with a bare `external:<owner>` instance
 * reference rather than a real ComponentDef (see the module doc comment) —
 * but the element's own directly-observed styling (its background/border,
 * and — for a "pill"-shaped leaf like Badge's `<span class="badge">` — its
 * own text) was still captured right here, in this exact render, for this
 * exact instance. Discarding it silently is what makes every instance of a
 * repeatedly-nested dependency component look identical even when the
 * parent was captured multiple times with genuinely different nested
 * content (e.g. three SessionCards, three different Badge colors/text) —
 * each instance only gets a shared, undifferentiated default from
 * whatever `owner`'s own separately-generated checkpoint happened to
 * capture once.
 *
 * This derives an `InstanceOverride[]` directly from `el`, mirroring
 * exactly the branch mapNode itself would have taken for this same
 * element had it not been replaced by an external reference — so the
 * computed `path`s resolve identically to how `owner`'s own standalone
 * capture would structure the same DOM shape:
 *  - a bare leaf-text root (mapNode's leaf-text branch) → override at the
 *    instance's own root (`path: []`), `characters` only;
 *  - an <img> root → no override (asset swapping for a nested image
 *    dependency is handled by buildInstanceOverridesFromPerInstanceData's
 *    image-slot matching at merge time, not here);
 *  - otherwise a frame root (mapFrameNode's branch, boxed or not) → the
 *    root's own fill/stroke at `path: []`, plus — only for the same
 *    leaf-with-box-styling ("pill") shape mapFrameNode synthesizes a text
 *    child for — that child's `characters` at `path: [0]`.
 *
 * Generic by construction: nothing here is specific to Badge, StatCard,
 * or any particular prop name/value — any nested dependency component
 * whose own root carries background/border/text gets this treatment.
 */
function buildNestedInstanceOverrides(el: ElementEvidence): InstanceOverride[] | undefined {
  if (el.children.length === 0 && el.textContent && !hasBoxStyling(el)) {
    return [{ path: [], characters: el.textContent }];
  }

  if (el.image) {
    return undefined;
  }

  const overrides: InstanceOverride[] = [];

  const fills: Fill[] = [];
  const bgColor = mapColor(el.style.backgroundColor);
  if (bgColor && bgColor.a > 0) fills.push({ type: "solid", color: bgColor });
  const { strokes } = mapBorder(el.style.border);
  if (fills.length > 0 || strokes.length > 0) {
    const rootOverride: InstanceOverride = { path: [] };
    if (fills.length > 0) rootOverride.fills = fills;
    if (strokes.length > 0) rootOverride.strokes = strokes;
    overrides.push(rootOverride);
  }

  if (el.children.length === 0 && el.textContent) {
    overrides.push({ path: [0], characters: el.textContent });
  }

  return overrides.length > 0 ? overrides : undefined;
}

/**
 * Whether this element has background/border/corner-radius styling that a
 * bare TextNode can't represent (see mapNode's leaf-text branch above).
 * Deliberately mirrors the fills/strokes computation in mapFrameNode —
 * "does this element need a frame" and "what does that frame's fill/
 * stroke look like" are answering the same underlying question from two
 * different call sites, so keep both in sync if either changes.
 */
/**
 * Shrinks `bounds` by `padding` on each side — the content box a browser
 * would actually lay padded content within. Used only for a synthesized
 * text child (see mapFrameNode) where no independently-measured DOM rect
 * exists for "just the text" to use instead. Clamped to zero rather than
 * going negative for the (CSS-invalid-in-practice, but not schema-
 * impossible) case of padding exceeding the element's own bounds.
 */
function insetByPadding(bounds: BoundsEvidence, padding: PaddingEvidence | null): BoundsEvidence {
  if (!padding) return bounds;
  return {
    x: bounds.x + padding.left,
    y: bounds.y + padding.top,
    width: Math.max(0, bounds.width - padding.left - padding.right),
    height: Math.max(0, bounds.height - padding.top - padding.bottom),
  };
}

function hasBoxStyling(el: ElementEvidence): boolean {
  const bg = mapColor(el.style.backgroundColor);
  if (bg && bg.a > 0) return true;
  if (el.style.backgroundImageUrl) return true;
  if (el.style.border && (el.style.border.top || el.style.border.right || el.style.border.bottom || el.style.border.left)) return true;
  if (el.style.cornerRadius?.parsedPx) return true;
  return false;
}

function mapColor(evidence: ColorEvidence | null): Color | null {
  if (!evidence?.parsed) return null;
  return evidence.parsed;
}

function mapTextNode(el: ElementEvidence, annotation: NodeAnnotation | undefined, ctx: BuildContext, boundsOverride?: BoundsEvidence): IRNode {
  const t = el.style.typography;
  const typography: Typography = {
    // t.fontFamily is the raw CSS fallback stack exactly as computed-style
    // reports it (e.g. `Inter, "Segoe UI", system-ui, sans-serif`) — never
    // a single resolved name (see TypographyEvidence.fontFamily). Figma's
    // font API takes exactly one family name, so this must be narrowed to
    // one here, at IR-construction time, rather than downstream in the
    // renderer — otherwise every text node with a real-world font stack
    // fails to load and silently falls back to Inter Regular even when
    // the intended font (e.g. Inter itself) is actually available.
    fontFamily: parseFontFamily(t.fontFamily) ?? "Inter",
    fontWeight: t.fontWeight ? Number(t.fontWeight) || 400 : 400,
    fontSize: t.fontSizePx ?? 16,
    lineHeight: t.lineHeightPx ?? undefined,
    letterSpacing: t.letterSpacingPx ?? undefined,
    textAlign: mapTextAlign(t.textAlign),
    italic: t.fontStyle === "italic",
  };
  const color = mapColor(t.color);

  return {
    type: "text",
    id: ctx.nextNodeId("text"),
    name: annotation?.semanticName ?? "Text",
    bounds: boundsOverride ?? el.bounds,
    characters: el.textContent ?? "",
    typography,
    fills: color ? [{ type: "solid", color }] : undefined,
  };
}

function mapImageNode(el: ElementEvidence, annotation: NodeAnnotation | undefined, ctx: BuildContext): IRNode {
  const assetId = ctx.registerAsset(el.image!.src, el.image!.naturalWidth, el.image!.naturalHeight);
  return {
    type: "image",
    id: ctx.nextNodeId("image"),
    name: annotation?.semanticName ?? el.image!.alt ?? "Image",
    bounds: el.bounds,
    assetId,
    cornerRadius: mapCornerRadius(el),
  };
}

/**
 * Resolves EVERY comma-separated `background-image` layer to a Fill, not
 * just the first — a real, previously-flagged gap (see
 * docs/adr/0008-ai-orchestration.md's "Known limitations": "which hasn't
 * been independently verified" about the correct stacking order).
 *
 * CSS layers `background-image` layers with the FIRST-listed one on TOP
 * (closest to the viewer) and `background-color` always at the very
 * bottom, below every image layer. Figma's `fills` array paints in the
 * opposite sense — later entries paint OVER earlier ones, so the
 * bottom-most paint must come FIRST in the array. This function returns
 * layers in that bottom-to-top order (last-listed CSS layer first,
 * first-listed CSS layer last); the caller is responsible for
 * `unshift`-ing background-color before these, since color is always
 * the true bottom regardless of how many image layers exist.
 *
 * Each layer resolves independently to a gradient (of any of the three
 * supported kinds) or a plain image (`url(...)`) — mixing kinds across
 * layers (e.g. a gradient over a photo) is exactly the case this exists
 * to support, not just multiple gradients. A layer that's `none` or
 * otherwise unparseable is dropped rather than blocking the layers
 * around it.
 */
function resolveBackgroundFills(el: ElementEvidence, ctx: BuildContext): Fill[] {
  if (!el.style.backgroundImage) return [];
  const layers = splitTopLevel(el.style.backgroundImage);
  const bounds = { width: el.bounds.width, height: el.bounds.height };

  const resolved = layers
    .map((layer): Fill | null => {
      const gradient = parseLinearGradient(layer, bounds) ?? parseRadialGradient(layer) ?? parseConicGradient(layer);
      if (gradient) return gradient;
      const url = parseCssUrl(layer);
      if (url) return { type: "image", assetId: ctx.registerAsset(url, null, null), scaleMode: "fill" };
      return null; // "none", or a layer this project doesn't parse (e.g. a raw <image-set()>)
    })
    .filter((f): f is Fill => f !== null);

  return resolved.reverse();
}

function mapFrameNode(
  el: ElementEvidence,
  path: number[],
  annotation: NodeAnnotation | undefined,
  interpretation: ComponentInterpretation,
  ctx: BuildContext
): IRNode {
  const fills: Fill[] = resolveBackgroundFills(el, ctx);
  const bgColor = mapColor(el.style.backgroundColor);
  if (bgColor && bgColor.a > 0) {
    fills.unshift({ type: "solid", color: bgColor }); // CSS: background-color always paints below every background-image layer
  }

  const { strokes, strokeWeights } = mapBorder(el.style.border);

  const effects: Effect[] = parseBoxShadow(el.style.boxShadow);
  const layerBlur = parseBlur(el.style.filter, "filter");
  if (layerBlur) effects.push(layerBlur);
  const backgroundBlur = parseBlur(el.style.backdropFilter, "backdrop-filter");
  if (backgroundBlur) effects.push(backgroundBlur);

  // A leaf element with text content only reaches mapFrameNode via the
  // hasBoxStyling() branch in mapNode (a styled "pill"/"button" element) —
  // el.children is empty by definition here, so the frame needs a
  // synthesized text child carrying this same element's own text/
  // typography/color, or the text itself would simply vanish while its
  // background/border render as an empty box.
  //
  // There's no separate DOM node for "just the text run inside el" to
  // independently measure — el itself both IS the text and owns the box
  // styling (e.g. Badge's `<span class="badge">`, a sidebar nav item
  // `<li>`) — so the synthesized child's bounds can't come from a real
  // measured rect the way every other text node's bounds do. Using el's
  // own bounds verbatim (the previous behavior) hands the synthesized
  // text the FULL frame box, padding included, which — combined with
  // Figma auto-hugging a left-aligned text layer to its content, anchored
  // at that box's top-left corner — pins the text into the frame's raw
  // top-left corner instead of the browser's actually-padded, roughly
  // centered position (the real reported "badge/sidebar-item text not
  // centered against its pill" bug). Insetting by el's own captured
  // padding recovers the content box the text is actually laid out
  // within, matching what the browser shows.
  const children =
    el.children.length === 0 && el.textContent
      ? [mapTextNode(el, undefined, ctx, insetByPadding(el.bounds, el.style.padding))]
      : el.children.map((child, i) => mapNode(child, [...path, i], interpretation, ctx));

  return {
    type: "frame",
    id: ctx.nextNodeId("frame"),
    name: annotation?.semanticName ?? defaultFrameName(el),
    bounds: el.bounds,
    layout: mapLayout(el),
    fills: fills.length > 0 ? fills : undefined,
    strokes: strokes.length > 0 ? strokes : undefined,
    strokeWeights,
    cornerRadius: mapCornerRadius(el),
    effects: effects.length > 0 ? effects : undefined,
    children,
  };
}

/**
 * Builds a frame's strokes + optional per-side strokeWeights from the four
 * independently-captured border sides (see BorderEvidence). Figma can only
 * paint ONE shared stroke color/style across a whole node —
 * individualStrokeWeights lets *widths* differ per side, not colors — so
 * when more than one side has a border, one side's color has to supply the
 * shared paint for all of them. That side is the widest one: a
 * thicker-than-its-neighbors side is a deliberate accent (StatCard's
 * left-border stripe, 4px next to 1px neutral borders elsewhere) and is
 * exactly the side whose color is the one meant to be visible/distinct —
 * picking whichever side merely happened to be captured/ordered first
 * (top/right/bottom/left) instead reliably picked the shared, non-accent
 * color and made every variant's accent stripe render identically. Equal-
 * width sides (including the fully-uniform case) fall back to the first
 * side with a resolvable color, same as before. A border that genuinely
 * differs in *color* per side at the *same* width (as opposed to
 * StatCard's much more common same-width-differs, or same-color-differs-
 * width, accent pattern) can't be represented by a plain frame's strokes
 * at all; that's accepted as a known limitation here rather than something
 * worth a separate overlay shape for.
 *
 * strokeWeights is only populated when the four sides' widths actually
 * differ — the common uniform-border case doesn't need it, Stroke.width
 * alone already says everything there is to say.
 */
function mapBorder(border: BorderEvidence | null): { strokes: Stroke[]; strokeWeights: StrokeWeights | undefined } {
  if (!border) return { strokes: [], strokeWeights: undefined };
  const sides = [border.top, border.right, border.bottom, border.left];
  const present = sides.filter((s): s is NonNullable<(typeof sides)[number]> => s !== null);
  if (present.length === 0) return { strokes: [], strokeWeights: undefined };

  const maxWidth = Math.max(...present.map((s) => s.widthPx));
  const widest = present.filter((s) => s.widthPx === maxWidth);
  const paintSide = widest.find((s) => mapColor(s.color)) ?? present.find((s) => mapColor(s.color)) ?? present[0];
  const color = mapColor(paintSide.color);
  if (!color) return { strokes: [], strokeWeights: undefined }; // no side has a usable color — nothing to paint

  const widths: StrokeWeights = {
    top: border.top?.widthPx ?? 0,
    right: border.right?.widthPx ?? 0,
    bottom: border.bottom?.widthPx ?? 0,
    left: border.left?.widthPx ?? 0,
  };
  const uniform = widths.top === widths.right && widths.right === widths.bottom && widths.bottom === widths.left;

  const stroke: Stroke = {
    color,
    width: Math.max(widths.top, widths.right, widths.bottom, widths.left),
    style: paintSide.style === "dashed" ? "dashed" : "solid",
  };
  return { strokes: [stroke], strokeWeights: uniform ? undefined : widths };
}

function mapLayout(el: ElementEvidence): Layout | undefined {
  if (el.style.layoutMode === "flex" && el.style.flex) {
    const f = el.style.flex;
    return {
      mode: f.direction?.startsWith("column") ? "vertical" : "horizontal",
      gap: f.gap ?? undefined,
      padding: el.style.padding ?? undefined,
      primaryAxisAlign: mapJustify(f.justifyContent),
      counterAxisAlign: mapAlign(f.alignItems),
      wrap: f.wrap === "wrap" ? true : undefined,
    };
  }
  if (el.style.layoutMode === "grid") {
    // ADR 0002: no semantic Grid node in design-ir/v1 — absolute-position fallback.
    // Children already carry their own `bounds`, so no further action is needed here.
    return { mode: "none" };
  }
  return undefined;
}

function mapJustify(raw: string | null): Layout["primaryAxisAlign"] {
  switch (raw) {
    case "center":
      return "center";
    case "flex-end":
      return "end";
    case "space-between":
      return "spaceBetween";
    default:
      return "start";
  }
}

function mapAlign(raw: string | null): Layout["counterAxisAlign"] {
  switch (raw) {
    case "center":
      return "center";
    case "flex-end":
      return "end";
    case "stretch":
      return "stretch";
    default:
      return "start";
  }
}

/**
 * design-ir/v1's `Typography.textAlign` is a closed 4-value enum (`left`,
 * `center`, `right`, `justify`) — a snapshot of what a Figma text node can
 * actually represent. The evidence layer (interpretDomSnapshot.ts)
 * correctly captures the *raw* CSS `text-align` computed value verbatim,
 * unmapped, per ADR 0007/0008's "deterministic evidence is never
 * silently reshaped" principle — mapping to the IR's restricted domain is
 * this construction layer's job, not evidence's.
 *
 * This was previously an unchecked cast straight from the raw CSS value,
 * which is a real bug, not a hypothetical one: `text-align: start` is the
 * CSS *initial* value in every modern browser (Chromium, Firefox, Safari)
 * — meaning any text node that never had `text-align` explicitly set —
 * the overwhelming majority of real UI text — reports `"start"`, not
 * `"left"`, from `getComputedStyle`. `"start"` isn't in the enum, so the
 * unchecked cast produced a TextNode failing schema validation on nearly
 * every text node in a real page. See docs/adr/0014-structured-output-
 * and-ir-construction.md.
 *
 * `start`/`end` map to `left`/`right` — a reasonable, standard default
 * for the overwhelmingly common left-to-right case (this evidence layer
 * doesn't currently capture element directionality/`writing-mode` to do
 * better than that). Anything else genuinely ambiguous (`match-parent`,
 * `inherit`, `initial`, `unset`, or an unrecognized future CSS value) is
 * omitted rather than guessed — `textAlign` is optional in the schema, so
 * "no opinion" is a fully valid, honest answer; fabricating one to force
 * a specific enum value would be exactly the kind of AI-free geometry
 * invention ADR 0008 rules out, just committed here in construction code
 * instead of by a model.
 */
function mapTextAlign(raw: string | null): Typography["textAlign"] {
  switch (raw) {
    case "left":
    case "start":
      return "left";
    case "right":
    case "end":
      return "right";
    case "center":
      return "center";
    case "justify":
      return "justify";
    default:
      return undefined;
  }
}

function mapCornerRadius(el: ElementEvidence): CornerRadius | undefined {
  return el.style.cornerRadius?.parsedPx ?? undefined;
}

function defaultFrameName(el: ElementEvidence): string {
  if (el.attributes.className) return el.attributes.className.split(" ")[0];
  return el.tag === "div" ? "Frame" : el.tag;
}

function guessMimeType(src: string): string {
  if (src.startsWith("data:")) {
    // data:<mimeType>[;base64],<payload> — the mime type is the segment
    // between "data:" and the first ";" or ",", whichever comes first.
    // Split on "." (this function's normal, extension-based path below)
    // would find none in a base64 payload's alphabet reliably and fall
    // through to "application/octet-stream" for what is very likely an
    // svgMarkupToDataUri()-produced captured icon (interpretDomSnapshot.ts).
    const match = /^data:([^;,]+)/.exec(src);
    return match?.[1] ?? "application/octet-stream";
  }
  const ext = src.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "svg":
      return "image/svg+xml";
    case "webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function slug(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}