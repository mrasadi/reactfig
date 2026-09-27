/**
 * A minimal fake of the Figma Plugin API surface this renderer actually
 * calls — NOT a re-implementation of Figma's rendering/geometry engine.
 * Tests built on this prove "the renderer called the correct API with the
 * correct arguments," not "this looks right when rendered in real Figma."
 * See packages/figma-plugin/README.md, "What's tested here, and what
 * isn't" for that distinction spelled out.
 */

let nodeCounter = 0;
function nextId(): string {
  return `fake-node-${nodeCounter++}`;
}

export interface FakeNode {
  id: string;
  type: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  fills: unknown[];
  strokes: unknown[];
  strokeWeight: number;
  strokeTopWeight: number;
  strokeRightWeight: number;
  strokeBottomWeight: number;
  strokeLeftWeight: number;
  dashPattern: number[];
  effects: unknown[];
  cornerRadius?: number;
  topLeftRadius?: number;
  topRightRadius?: number;
  bottomLeftRadius?: number;
  bottomRightRadius?: number;
  layoutMode?: string;
  layoutWrap?: string;
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  counterAxisSizingMode?: string;
  layoutAlign?: string;
  /**
   * "AUTO" (Figma's own default — participates in the parent's Auto
   * Layout flow) or "ABSOLUTE" (opted out, keeps independently-set x/y)
   * — see the `x`/`y` setter simulation below and docs/adr/0031.
   */
  layoutPositioning?: "AUTO" | "ABSOLUTE";
  /** Figma frames/components clip their contents by default (`true`) — see docs/adr/0031. Not simulated as actual visual clipping (this fake draws nothing), only stored, so a test can assert the renderer set it explicitly rather than leaving Figma's own default in effect. */
  clipsContent: boolean;
  children: FakeNode[];
  parent: FakeNode | null;
  componentProperties: Array<{ name: string; type: string; defaultValue: unknown }>;
  mainComponent?: FakeNode;
  resize(width: number, height: number): void;
  appendChild(child: FakeNode): void;
  addComponentProperty(name: string, type: string, defaultValue: unknown): void;
  createInstance(): FakeNode;
  remove(): void;
}

function makeNode(type: string): FakeNode {
  // Backing storage for the x/y accessor pair below — kept as ordinary
  // closed-over variables (not object fields) so `node.x =`/`node.y =`
  // can be intercepted via Object.defineProperty without an extra layer
  // of indirection visible to callers (they still just read/write
  // `node.x`/`node.y` like plain fields everywhere else in this file and
  // in the real renderer).
  let rawX = 0;
  let rawY = 0;

  const node: FakeNode = {
    id: nextId(),
    type,
    name: "",
    width: 0,
    height: 0,
    opacity: 1,
    fills: [],
    strokes: [],
    strokeWeight: 0,
    strokeTopWeight: 0,
    strokeRightWeight: 0,
    strokeBottomWeight: 0,
    strokeLeftWeight: 0,
    dashPattern: [],
    effects: [],
    // Real Figma frames/components clip by default — see this interface's
    // own doc comment above and docs/adr/0031. Every node type gets this
    // field (not just frame-like ones) purely for simplicity; the real
    // renderer only ever reads/writes it on frame-like nodes, same as
    // real Figma only exposing it there.
    clipsContent: true,
    // Real Figma nodes always have this property (default "AUTO") once
    // they support Auto Layout membership at all — see this interface's
    // own doc comment above. Must be present as an OWN key from creation
    // (not left undefined) so `"layoutPositioning" in child` in the real
    // renderer's geometry.ts `placeInParent` — a defensive type-narrowing
    // guard for node types that genuinely don't support it — correctly
    // finds it, the same way it always would against a real Figma node.
    layoutPositioning: "AUTO",
    children: [],
    parent: null,
    componentProperties: [],
    resize(width, height) {
      node.width = width;
      node.height = height;
    },
    appendChild(child) {
      child.parent?.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = node;
      node.children.push(child);
    },
    addComponentProperty(name, type, defaultValue) {
      node.componentProperties.push({ name, type, defaultValue });
    },
    createInstance() {
      const instance = makeNode("INSTANCE");
      instance.mainComponent = node;
      instance.width = node.width;
      instance.height = node.height;
      // Real Figma instances inherit the master's unset visual properties
      // (cornerRadius, fills, etc.) until a property is explicitly
      // overridden on the instance — matches that for the properties this
      // renderer actually reads/writes post-creation. Real instances also
      // mirror the master's full child tree (each nested instance's own
      // master's tree too) onto their own `.children` — needed so
      // InstanceOverride.path (a flat `.children[i]` walk, transparent to
      // nested-instance crossings — see renderNode.ts's
      // applyInstanceOverrides) resolves the same way here as it does
      // against real Figma.
      instance.cornerRadius = node.cornerRadius;
      // Real Figma instances also inherit the master's own top-level
      // visual properties (fills/strokes/strokeWeight), not just its
      // children — cloneForInstance below already mirrors these onto
      // every nested child, but this top-level instance node is created
      // fresh via makeNode() and was never given the same treatment,
      // so any test asserting fills/strokes directly on a rendered
      // instance's root (rather than on one of its children) saw the
      // fake's own INSTANCE-node default instead of the master's real
      // value. A Badge/Avatar-style override at path:[] masked this
      // (it sets instance.fills/strokes directly, after creation,
      // regardless of inheritance) — a componentSet variant's own
      // baked-in root strokes, with no override at all (e.g. StatCard's
      // tone-colored border), did not.
      instance.fills = node.fills;
      instance.strokes = node.strokes;
      instance.strokeWeight = node.strokeWeight;
      instance.children = node.children.map((child) => cloneForInstance(child, instance));
      return instance;
    },
    remove() {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      node.parent = null;
    },
  };

  // x/y as an accessor pair, not plain fields (docs/adr/0031) — simulates
  // real Figma's documented Auto Layout behavior: assigning x/y on a
  // child of an Auto-Layout frame (layoutMode !== "NONE") is a NO-OP
  // unless that child's own layoutPositioning is "ABSOLUTE" (see
  // @figma/plugin-typings' own doc comment for layoutPositioning, and
  // geometry.ts's placeInParent). This is NOT a full reimplementation of
  // Figma's flex algorithm (real auto-layout would compute a specific
  // position from padding/gap/alignment; this fake leaves a blocked
  // assignment at whatever it was before, typically 0) — the previous
  // top-of-file doc comment's own distinction still holds ("proves the
  // renderer called the right API," not pixel-perfect Figma fidelity) —
  // but it faithfully reproduces the ONE fact that matters for this bug
  // class: an unmarked child's explicit position silently fails to apply.
  Object.defineProperty(node, "x", {
    enumerable: true,
    get() {
      return rawX;
    },
    set(value: number) {
      if (node.parent?.layoutMode && node.parent.layoutMode !== "NONE" && node.layoutPositioning !== "ABSOLUTE") return;
      rawX = value;
    },
  });
  Object.defineProperty(node, "y", {
    enumerable: true,
    get() {
      return rawY;
    },
    set(value: number) {
      if (node.parent?.layoutMode && node.parent.layoutMode !== "NONE" && node.layoutPositioning !== "ABSOLUTE") return;
      rawY = value;
    },
  });

  return node;
}

function cloneForInstance(source: FakeNode, parent: FakeNode): FakeNode {
  const clone = makeNode(source.type === "COMPONENT" ? "INSTANCE" : source.type);
  Object.assign(clone, {
    name: source.name,
    x: source.x,
    y: source.y,
    width: source.width,
    height: source.height,
    opacity: source.opacity,
    fills: source.fills,
    strokes: source.strokes,
    strokeWeight: source.strokeWeight,
    cornerRadius: source.cornerRadius,
    fontName: (source as unknown as { fontName?: unknown }).fontName,
    fontSize: (source as unknown as { fontSize?: unknown }).fontSize,
    characters: (source as unknown as { characters?: unknown }).characters,
    parent,
  });
  clone.children = source.children.map((c) => cloneForInstance(c, clone));
  return clone;
}

export interface FakeFigmaOptions {
  /** Font families (e.g. "Inter") that should reject loadFontAsync, to exercise the fallback path. */
  unavailableFonts?: string[];
}

export function createFakeFigma(options: FakeFigmaOptions = {}) {
  nodeCounter = 0;
  const currentPage = makeNode("PAGE");
  const unavailable = new Set(options.unavailableFonts ?? []);
  const loadFontCalls: FontName[] = [];
  const createImageCalls: Uint8Array[] = [];
  const createSvgCalls: string[] = [];

  const fake = {
    currentPage,
    viewport: { scrollAndZoomIntoView: (_nodes: FakeNode[]) => {} },
    createFrame: () => {
      const n = makeNode("FRAME");
      n.layoutMode = "NONE";
      currentPage.appendChild(n);
      return n;
    },
    createComponent: () => {
      const n = makeNode("COMPONENT");
      n.layoutMode = "NONE";
      currentPage.appendChild(n);
      return n;
    },
    createText: () => {
      const n = makeNode("TEXT") as FakeNode & { characters: string; fontName: FontName; fontSize: number; lineHeight: unknown; letterSpacing: unknown; textAlignHorizontal: string; textAutoResize: string };
      n.characters = "";
      currentPage.appendChild(n);
      return n;
    },
    createRectangle: () => {
      const n = makeNode("RECTANGLE");
      currentPage.appendChild(n);
      return n;
    },
    createEllipse: () => {
      const n = makeNode("ELLIPSE");
      currentPage.appendChild(n);
      return n;
    },
    createNodeFromSvg: (svg: string) => {
      createSvgCalls.push(svg);
      const n = makeNode("FRAME"); // Figma's real API also returns a FrameNode for SVG import
      currentPage.appendChild(n);
      return n;
    },
    createImage: (bytes: Uint8Array) => {
      createImageCalls.push(bytes);
      return { hash: `hash-${createImageCalls.length}`, getSizeAsync: async () => ({ width: 1, height: 1 }) };
    },
    loadFontAsync: async (font: FontName) => {
      loadFontCalls.push(font);
      if (unavailable.has(font.family)) {
        throw new Error(`font not available: ${font.family}`);
      }
    },
    group: (nodes: FakeNode[], parent: FakeNode) => {
      const g = makeNode("GROUP");
      parent.appendChild(g);
      for (const n of nodes) g.appendChild(n);
      return g;
    },
    combineAsVariants: (nodes: FakeNode[], parent: FakeNode) => {
      const set = makeNode("COMPONENT_SET");
      parent.appendChild(set);
      for (const n of nodes) set.appendChild(n);
      set.addComponentProperty = (name, type, defaultValue) => set.componentProperties.push({ name, type, defaultValue });
      return set;
    },
  };

  return { figma: fake as unknown as typeof figma, loadFontCalls, createImageCalls, createSvgCalls, currentPage };
}