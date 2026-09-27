/**
 * The Evidence Model is deliberately NOT the Design IR.
 *
 * Pipeline: React/TSX → Deterministic Analyzer → Evidence Model → AI reasoning → Design IR
 *
 * Evidence is everything the analyzer could determine without asking a
 * model anything: DOM structure, computed styles, bounding boxes, source
 * props/types, JSX composition, screenshots. It intentionally preserves
 * more than the Design IR needs (e.g. raw CSS Grid template strings) so
 * that a later phase — or a future IR version — can use information that
 * v1 IR doesn't model yet, without re-touching the inspection layer.
 *
 * This file has zero dependency on @reactfig/core (the IR package) and
 * zero dependency on any model/AI package — evidence is model-agnostic by
 * construction.
 */

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------

/** Both the raw CSS string and a best-effort parse, so nothing is lost if parsing fails or is imprecise. */
export interface ColorEvidence {
  raw: string;
  parsed: { r: number; g: number; b: number; a: number } | null;
}

// ---------------------------------------------------------------------------
// Layout evidence
// ---------------------------------------------------------------------------

export type LayoutModeEvidence = "flex" | "grid" | "block" | "inline" | "inline-block" | "other";

export interface FlexEvidence {
  direction: string | null; // raw flex-direction
  justifyContent: string | null;
  alignItems: string | null;
  wrap: string | null;
  gap: number | null;
  rowGap: number | null;
  columnGap: number | null;
}

/**
 * Raw CSS Grid evidence, preserved even though design-ir/v1 does not model
 * Grid semantically (see ADR 0002 / ADR 0005 and docs/design-ir/README.md).
 * Kept so a future IR version can add semantic Grid support without the
 * inspection layer needing to change — the data was never thrown away.
 */
export interface GridEvidence {
  templateColumns: string | null;
  templateRows: string | null;
  autoFlow: string | null;
  gap: number | null;
  rowGap: number | null;
  columnGap: number | null;
}

/** Present on a child whose parent uses CSS Grid — its own placement within that grid. */
export interface GridChildPlacementEvidence {
  column: string | null; // raw grid-column value, e.g. "2 / 4"
  row: string | null;
}

export interface PaddingEvidence {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

// ---------------------------------------------------------------------------
// Visual style evidence
// ---------------------------------------------------------------------------

export interface BorderSideEvidence {
  widthPx: number;
  style: string | null;
  color: ColorEvidence | null;
}

/**
 * All four sides captured independently — CSS lets each side differ (e.g. a
 * StatCard-style accent stripe: `border: 1px solid gray; border-left: 4px
 * solid green;` is a uniform 1px border on three sides plus a distinct 4px
 * left edge). A single shared width/style/color, as if every border were
 * uniform, would silently keep whichever one side happened to be read and
 * drop the other three's actual values — exactly the "StatCard's left
 * accent border doesn't render" bug this shape exists to avoid. A side is
 * `null` when that edge has no border at all (matches `PaddingEvidence`'s
 * existing per-side pattern in this file, one level down: each entry is
 * itself nullable rather than defaulting to a zero-width border).
 */
export interface BorderEvidence {
  top: BorderSideEvidence | null;
  right: BorderSideEvidence | null;
  bottom: BorderSideEvidence | null;
  left: BorderSideEvidence | null;
}

/** Raw CSS + best-effort parse, mirroring ColorEvidence's raw+parsed pattern (see docs/analyzer/evidence-model.md, "typed values alongside raw"). */
export interface CornerRadiusEvidence {
  raw: string;
  parsedPx: number | [number, number, number, number] | null;
}

export interface TypographyEvidence {
  fontFamily: string | null;
  fontSizePx: number | null;
  fontWeight: string | null;
  fontStyle: string | null; // raw: "normal" | "italic" | "oblique ..."
  lineHeight: string | null; // raw — may be "normal", "1.5", "24px"
  lineHeightPx: number | null; // parsed only when the raw value is in px form; null for unitless/percentage/"normal"
  letterSpacing: string | null;
  letterSpacingPx: number | null;
  textAlign: string | null;
  /** raw white-space value (e.g. "nowrap") — needed to tell truncated/no-wrap text from normally-wrapping text. */
  whiteSpace: string | null;
  /** raw text-overflow value (e.g. "ellipsis") — paired with whiteSpace to detect truncation. */
  textOverflow: string | null;
  color: ColorEvidence | null;
}

export interface StyleEvidence {
  display: string | null;
  layoutMode: LayoutModeEvidence;
  position: string | null;
  /** raw z-index, when set to something other than "auto" — matters for overlapping absolutely-positioned siblings (e.g. a badge over an avatar). */
  zIndex: number | null;
  flex: FlexEvidence | null; // present when layoutMode === "flex"
  grid: GridEvidence | null; // present when layoutMode === "grid"
  gridChildPlacement: GridChildPlacementEvidence | null; // present when the PARENT is grid, regardless of this node's own display
  padding: PaddingEvidence | null;
  margin: PaddingEvidence | null;
  backgroundColor: ColorEvidence | null;
  backgroundImage: string | null; // raw CSS value, e.g. url("...") or a gradient function
  /** The URL extracted from `backgroundImage` when it's a url(...) reference — null for gradients or when absent. Only the URL is captured, not natural dimensions (see docs/analyzer/evidence-model.md limitations). */
  backgroundImageUrl: string | null;
  border: BorderEvidence | null;
  cornerRadius: CornerRadiusEvidence | null;
  boxShadow: string | null; // raw — not parsed into structured shadows in v1 evidence
  /** Raw `filter` CSS value (e.g. "blur(4px)" or "blur(4px) brightness(1.1)") — null when absent/"none". Only the blur() function is mapped to an Effect (layerBlur); other filter functions (brightness, contrast, grayscale, etc.) have no design-ir equivalent and are captured here but not mapped — see parseBlur.ts. */
  filter: string | null;
  /** Raw `backdrop-filter` CSS value — same shape/limitation as `filter`, mapped to a backgroundBlur Effect instead of layerBlur. */
  backdropFilter: string | null;
  opacity: number | null;
  overflow: string | null;
  typography: TypographyEvidence;
}

// ---------------------------------------------------------------------------
// DOM element evidence
// ---------------------------------------------------------------------------

export interface ImageAssetEvidence {
  src: string;
  naturalWidth: number | null;
  naturalHeight: number | null;
  alt: string | null;
}

export interface BoundsEvidence {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementEvidence {
  tag: string; // lowercase host tag, e.g. "div", "span", "img", "button"
  attributes: { id?: string; className?: string; role?: string };
  /** Direct text-node content only — does not include descendant text. */
  textContent: string | null;
  bounds: BoundsEvidence;
  style: StyleEvidence;
  image: ImageAssetEvidence | null;
  /**
   * Best-effort chain of component display names that own this DOM node,
   * outermost (the captured root component) first, e.g. ["SessionCard", "Avatar"].
   * Derived from the React fiber `_debugOwner` chain in the browser (see
   * browser/collectDomSnapshot.ts) — the same mechanism React DevTools
   * itself uses for its Components tree. Only available in React
   * development builds; null when unavailable (production builds, no
   * matching fiber, or the element isn't React-managed).
   */
  componentPath: string[] | null;
  /**
   * True when this node is the first DOM node belonging to its nearest
   * owning component — i.e. `componentPath`'s last entry differs from the
   * parent node's. Marks component boundaries without requiring a caller
   * to diff componentPath arrays themselves.
   */
  isComponentRoot: boolean;
  children: ElementEvidence[];
}

// ---------------------------------------------------------------------------
// Source (AST) evidence
// ---------------------------------------------------------------------------

export interface PropEvidence {
  name: string;
  tsType: string;
  required: boolean;
  /** Populated when the prop's type is a union of string literals — a variant-axis candidate, not a guarantee. */
  literalValues?: string[];
  defaultValue?: string;
  isEventHandler: boolean;
}

/** One node in the JSX tree as written in source — corroborating structural evidence, not a DOM mapping. */
export interface JsxOutlineNode {
  /** Lowercase = host element (e.g. "div"), capitalized = a referenced component (e.g. "Avatar"), or "Fragment" / "Expression" / "Text". */
  tag: string;
  /** JSX attribute names, with literal string values where statically known; `true` for dynamic/unresolved values. */
  attributes: Record<string, string | true>;
  children: JsxOutlineNode[];
}

export interface ImportedComponentRef {
  name: string;
  moduleSpecifier: string;
  /**
   * Absolute path to the file that actually declares/exports this component,
   * resolved by following TypeScript module resolution (and any barrel /
   * re-export chain — `moduleSpecifier` alone doesn't tell you the real
   * declaring file when it points at an `index.ts` barrel). Undefined when
   * it couldn't be resolved to a project source file — e.g. an external
   * package (`lucide-react`), a path alias `tsconfig` doesn't know about, or
   * a declaration ts-morph couldn't follow. Used to walk the composition
   * tree (see `inspectComponentDependencyTree`) without a caller having to
   * already know, or guess, where each sub-component lives on disk.
   */
  resolvedFile?: string;
}

export interface ComponentSourceEvidence {
  file: string;
  exportName: string;
  props: PropEvidence[];
  /** Root of the JSX tree returned by the component, as written — not the rendered DOM. */
  jsx: JsxOutlineNode | null;
  /** Capitalized JSX tags in `jsx` that resolve to an import, i.e. sub-components this component composes. */
  importedComponents: ImportedComponentRef[];
  /**
   * Whether this component's own body calls `createPortal` anywhere —
   * see `detectPortalUsage.ts`'s doc comment for why this matters: a
   * portaled child renders outside this component's own DOM subtree
   * entirely, so this component's own captured evidence may be missing
   * content that a design reviewer would expect to see as part of it
   * (a modal, a tooltip, a dropdown menu). Not a claim that capture
   * failed — only that it may be incomplete, and why.
   */
  usesPortal: boolean;
}

// ---------------------------------------------------------------------------
// Render capture (one inspected state: default props, a specific variant, a viewport, ...)
// ---------------------------------------------------------------------------

export interface ScreenshotEvidence {
  /** Path on disk where the analyzer wrote the crop, relative to the analyzer's working output dir. */
  path: string;
  width: number;
  height: number;
}

export interface RenderCapture {
  /** Human-readable label for this capture, e.g. "default", "variant=primary,size=large", "viewport=mobile". */
  label: string;
  viewport: { width: number; height: number };
  /** Structured viewport name (e.g. "desktop", "mobile"), when this capture is part of a responsive sweep — distinct from the free-text `label` for reliable programmatic grouping. */
  viewportLabel?: string;
  /** Present when this capture corresponds to a specific prop/variant combination the analyzer rendered deliberately. */
  propValues?: Record<string, unknown>;
  /**
   * Present when this capture was taken after deliberately simulating a
   * DOM interaction (hover/focus/mousedown) rather than just rendering
   * default props — see playwrightCapture.ts's interaction-driving code
   * and docs/adr/0023-interaction-state-capture.md. Absent (not
   * `"default"`) for an ordinary prop/default capture — `undefined` is
   * itself the "no interaction" state, same convention as `propValues`
   * being absent for a non-variant capture.
   */
  interactionState?: "hover" | "focus" | "active";
  dom: ElementEvidence;
  /** Component-level crop — the primary visual evidence for this capture. */
  screenshot: ScreenshotEvidence | null;
  /** Optional lower-priority page/context screenshot, only when layout genuinely depends on surrounding content (see docs/architecture.md, "Vision"). */
  contextScreenshot: ScreenshotEvidence | null;
  capturedUrl: string;
  capturedAt: string; // ISO 8601
  /**
   * How many elements the capture's selector matched in the DOM at the
   * time of capture — see captureComponent.ts. 1 is the expected,
   * unambiguous case; a value greater than 1 means the selector wasn't
   * specific enough to uniquely identify this component's root, and
   * whichever element was actually captured (the first DOM match) may or
   * may not be the intended one. Optional only for capture sources that
   * predate this field (e.g. hand-built fixtures in tests) — always
   * populated by the real Playwright-backed capture path.
   */
  matchCount?: number;
}

// ---------------------------------------------------------------------------
// Component evidence — the top-level unit AI reasoning consumes
// ---------------------------------------------------------------------------

export interface ComponentEvidence {
  componentName: string;
  source: ComponentSourceEvidence;
  captures: RenderCapture[];
  meta: {
    analyzerVersion: string;
    /**
     * Known, intentional gaps in this evidence — surfaced explicitly rather
     * than silently. E.g. "no DOM-to-JSX node mapping beyond the component
     * root" or "grid detected, IR v1 uses absolute-position fallback".
     */
    limitations: string[];
  };
}
