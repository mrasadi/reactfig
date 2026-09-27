/**
 * design-ir/v1
 *
 * These types describe design SEMANTICS, not any particular renderer's
 * implementation. Figma is one renderer target (packages/figma-plugin);
 * an SVG or HTML renderer is expected to consume the same documents.
 *
 * See docs/design-ir/README.md for the prose spec and rationale, and
 * docs/adr/0005-design-ir-v1-details.md for decisions made while writing
 * this file (arrays for fill/effect, bounds+layout hybrid, color format,
 * single-style text, ComponentSet/Variant/Instance shape).
 */

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export interface DesignDocument {
  $schema: "https://reactfig.dev/schema/design-ir/v1.json";
  version: "design-ir/v1";
  id: string;
  name: string;
  pages: Page[];
  /** Reusable component definitions, referenced by Instance nodes via componentRef. */
  components: (ComponentDef | ComponentSet)[];
  /** Registry of assets referenced by Image nodes / image fills. Bytes live in the .rfd artifact's assets/. */
  assets: AssetRef[];
  meta: DocumentMeta;
}

export interface DocumentMeta {
  generator: string; // e.g. "@reactfig/analyzer@0.1.0"
  generatedAt: string; // ISO 8601
  sourceProject?: {
    name?: string;
    /** Repo-relative root the analyzer was pointed at. */
    root?: string;
  };
}

export interface Page {
  id: string;
  name: string;
  children: Node[];
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** 0–1 floats, matching both common design-tool conventions and trivial CSS conversion. */
export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Corner radius: a single number (uniform) or four values
 * [topLeft, topRight, bottomRight, bottomLeft], matching CSS border-radius order.
 */
export type CornerRadius = number | [number, number, number, number];

export type SizeMode = "fixed" | "hug" | "fill";

export interface AxisSize {
  mode: SizeMode;
  /** Required when mode is "fixed"; ignored otherwise. */
  value?: number;
}

/** Flexbox-equivalent auto-layout. See ADR 0002 — this is the only layout model in v1. */
export interface Layout {
  mode: "none" | "horizontal" | "vertical";
  gap?: number;
  padding?: { top: number; right: number; bottom: number; left: number };
  primaryAxisAlign?: "start" | "center" | "end" | "spaceBetween";
  counterAxisAlign?: "start" | "center" | "end" | "stretch";
  wrap?: boolean;
}

export type TokenRef = { token: string };
/** A value that may be a literal or a reference to a design token. v1: informational only — renderers may resolve tokens or fall back to treating them as opaque and skip resolution. */
export type TokenOr<T> = T | TokenRef;

export type Fill =
  | { type: "solid"; color: TokenOr<Color> }
  | { type: "image"; assetId: string; scaleMode?: "fill" | "fit" | "tile" | "stretch" }
  | {
      type: "linearGradient";
      stops: { position: number; color: Color }[];
      angleDeg: number;
    }
  | {
      type: "radialGradient";
      stops: { position: number; color: Color }[];
      /** 0–1, fraction of the node's own bounding box — CSS's `at X% Y%` position, or (0.5, 0.5) for the CSS default ("center"). No per-axis radius/shape concept in v1 — see parseRadialGradient.ts's doc comment. */
      centerX: number;
      centerY: number;
    }
  | {
      type: "conicGradient";
      stops: { position: number; color: Color }[];
      centerX: number;
      centerY: number;
      /** CSS's `from <angle>`, normalized to degrees — 0 when absent. */
      startAngleDeg: number;
    };

export interface Stroke {
  color: TokenOr<Color>;
  width: number;
  style?: "solid" | "dashed";
}

/**
 * Per-side stroke widths — Figma's `individualStrokeWeights` concept.
 * Omitted for the common case (a uniform border on all sides, or no
 * border), where `Stroke.width` alone already says everything there is to
 * say. Present when CSS gave different sides different widths — e.g. a
 * `border-left` accent stripe on an otherwise thin-bordered card — which a
 * single shared `Stroke.width` can't represent at all (Figma itself can
 * only paint one shared stroke *color* across a node, though, so a stroke
 * that differs in *color* per side, not just width, still can't be
 * represented by a plain frame's strokes — rare enough in practice, next
 * to a same-color accent-width pattern, that it's left as a known gap
 * rather than modeled here).
 */
export interface StrokeWeights {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type Effect =
  | {
      type: "dropShadow" | "innerShadow";
      color: Color;
      offsetX: number;
      offsetY: number;
      blur: number;
      spread?: number;
    }
  | { type: "layerBlur" | "backgroundBlur"; radius: number };

export interface Typography {
  fontFamily: string;
  /** CSS-style numeric weight (400, 600, 700, ...). */
  fontWeight: number;
  fontSize: number;
  lineHeight?: number | { unit: "percent"; value: number };
  letterSpacing?: number;
  textAlign?: "left" | "center" | "right" | "justify";
  italic?: boolean;
}

export interface SourceMapping {
  file: string;
  export?: string;
  /** Snapshot of the React props observed for this node at capture time, for debugging/traceability. */
  props?: Record<string, unknown>;
}

export interface AssetRef {
  id: string;
  /** Path within the .rfd artifact's assets/ directory. */
  path: string;
  mimeType: string;
  width?: number;
  height?: number;
}

// ---------------------------------------------------------------------------
// Node base + variants
// ---------------------------------------------------------------------------

interface NodeBase {
  id: string;
  name: string;
  visible?: boolean; // default true
  opacity?: number; // 0-1, default 1
  /**
   * Last-known rendered geometry. In practice every producer of this IR
   * (see @reactfig/analyzer's evidence pipeline) captures bounds via
   * getBoundingClientRect(), which is viewport/document-absolute, not
   * parent-relative — and no stage re-relativizes it. Renderers that need
   * a child's position relative to its parent (e.g. to set a Figma node's
   * x/y, which IS parent-relative) must compute it themselves by
   * subtracting the parent's bounds from the child's. This was corrected
   * from an earlier ("parent-relative") doc comment during Phase 6's
   * feasibility review — see docs/figma-plugin/feasibility.md,
   * "Corrections to prior assumptions" #1. The underlying data was never
   * wrong, only this comment was.
   */
  bounds: Bounds;
  source?: SourceMapping;
}

export interface FrameNode extends NodeBase {
  type: "frame";
  children: Node[];
  layout?: Layout;
  fills?: Fill[];
  strokes?: Stroke[];
  strokeWeights?: StrokeWeights;
  cornerRadius?: CornerRadius;
  effects?: Effect[];
  clipsContent?: boolean;
}

export interface GroupNode extends NodeBase {
  type: "group";
  children: Node[];
}

export interface TextNode extends NodeBase {
  type: "text";
  characters: string;
  typography: Typography;
  fills?: Fill[]; // text color; array for consistency, v1 expects exactly one solid fill in practice
  /**
   * v1 supports one style per Text node (no mixed-style runs within a single
   * block). A React node with mixed inline styling should be captured as
   * multiple sibling Text nodes. See ADR 0005.
   */
}

export interface ShapeNode extends NodeBase {
  type: "shape";
  shape: "rectangle" | "ellipse";
  fills?: Fill[];
  strokes?: Stroke[];
  cornerRadius?: CornerRadius;
  effects?: Effect[];
}

export interface ImageNode extends NodeBase {
  type: "image";
  assetId: string;
  cornerRadius?: CornerRadius;
  effects?: Effect[];
}

export interface InstanceNode extends NodeBase {
  type: "instance";
  componentRef:
    | { kind: "component"; componentId: string }
    | { kind: "variant"; componentSetId: string; variantId: string };
  /** Overrides for non-variant properties (e.g. a boolean "showIcon" or text override). */
  propertyOverrides?: Record<string, string | number | boolean>;
  /**
   * Per-node content overrides applied on top of this instance's
   * referenced component — the mechanism that lets two instances of the
   * same component (e.g. two StatCards) show different data instead of
   * both baking in whatever text/fill/stroke the component was captured
   * with. Each entry targets one descendant node via `path` (see
   * `InstanceOverride`); unlike `propertyOverrides` (which requires the
   * component to have declared a matching ComponentProperty), this
   * addresses a node directly and needs no declared property, so it's the
   * mechanism `mergeDesignDocuments`'s `instanceOverrides` option produces.
   */
  overrides?: InstanceOverride[];
  /**
   * Present only when the instance's layout diverges from its source
   * component's root layout (e.g. a fill-sized instance in a flex parent).
   */
  layout?: Layout;
}

/**
 * A content override targeting one descendant node inside an instance's
 * referenced component (or, transitively, inside a component nested
 * further within it — a Badge instance inside a SessionCard instance).
 *
 * `path` is a sequence of child-array indices, walked from the top of the
 * referenced component's root: `path: [0, 2]` means "root's first child's
 * third child". Whenever the walk lands on an `instance` node and the path
 * continues, indexing transparently restarts at the top of *that* nested
 * instance's own referenced component root — mirroring how a real Figma
 * instance's `.children` mirrors its master (including nested instances),
 * so path resolution at render time is a single flat `.children[i]` walk
 * with no special-casing for the crossing (see
 * packages/figma-plugin/src/code/render/renderNode.ts's
 * `applyInstanceOverrides`). An empty path targets the instance's root
 * node itself.
 *
 * At least one of `characters`/`fills`/`strokes` should be present;
 * omitted fields are left as the component's own captured value. Swapping
 * which asset an ImageNode target renders (e.g. one SessionCard's Avatar
 * showing a different learner's photo) uses `fills`, same as any other
 * fill-bearing node — an ImageNode always renders as a fill-carrying node
 * at render time (see packages/figma-plugin/src/code/render/renderNode.ts's
 * renderImage), so a `{type: "image", assetId}` Fill entry here is all
 * that's needed; there's no separate "assetId override" field.
 */
export interface InstanceOverride {
  path: number[];
  /** Only meaningful when the target node is a TextNode. */
  characters?: string;
  fills?: Fill[];
  strokes?: Stroke[];
}

export type Node = FrameNode | GroupNode | TextNode | ShapeNode | ImageNode | InstanceNode;

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export type ComponentPropertyType = "boolean" | "text" | "instanceSwap";

export interface ComponentProperty {
  name: string;
  type: ComponentPropertyType;
  defaultValue?: string | number | boolean;
}

/** A component with no variant axes (e.g. a single Input). */
export interface ComponentDef {
  kind: "component";
  id: string;
  name: string;
  properties?: ComponentProperty[];
  root: Node;
  source?: SourceMapping;
}

/** A component family with variant axes (e.g. Button × variant × size). */
export interface ComponentSet {
  kind: "componentSet";
  id: string;
  name: string;
  /** The variant axes shared across all variants, e.g. [{name:"variant", ...}, {name:"size", ...}]. */
  variantProperties: VariantPropertyDef[];
  /** Non-variant properties shared across all variants (booleans, text overrides). */
  properties?: ComponentProperty[];
  variants: ComponentVariant[];
  source?: SourceMapping;
}

export interface VariantPropertyDef {
  name: string;
  values: string[];
}

export interface ComponentVariant {
  id: string;
  /** One value per entry in the owning ComponentSet's variantProperties. */
  propertyValues: Record<string, string>;
  root: Node;
  source?: SourceMapping;
}
