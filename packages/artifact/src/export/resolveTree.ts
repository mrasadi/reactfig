import type {
  Bounds,
  Color,
  ComponentDef,
  ComponentSet,
  DesignDocument,
  Fill,
  InstanceOverride,
  Node,
  TokenOr,
} from "@reactfig/core";

/**
 * A fully-resolved, positioned node ready to draw: instance nodes have
 * been expanded to their referenced component/variant root (recursively,
 * including nested instances), overrides have been applied, and `bounds`
 * has been translated so the whole tree is expressed relative to the
 * export root's own top-left corner (0,0) — see NodeBase.bounds's own
 * doc comment: raw Design IR bounds are document/viewport-absolute, not
 * parent-relative, so a renderer that isn't Figma itself has to do this
 * translation once, here, rather than per-consumer.
 */
export interface ResolvedNode {
  node: Node;
  /** Bounds translated into export-root-relative space. */
  bounds: Bounds;
  children: ResolvedNode[];
}

function findComponent(doc: DesignDocument, componentId: string): ComponentDef | ComponentSet | undefined {
  return doc.components.find((c) => c.id === componentId);
}

function rootOf(comp: ComponentDef | ComponentSet, variantId?: string): Node | undefined {
  if (comp.kind === "component") return comp.root;
  const variant = comp.variants.find((v) => v.id === variantId);
  return variant?.root;
}

function applyOverrideTo(node: Node, override: InstanceOverride | undefined): Node {
  if (!override) return node;
  if (node.type === "text" && override.characters !== undefined) {
    node = { ...node, characters: override.characters };
  }
  if ("fills" in node && override.fills !== undefined) {
    node = { ...node, fills: override.fills } as Node;
  }
  if ("strokes" in node && override.strokes !== undefined) {
    node = { ...node, strokes: override.strokes } as Node;
  }
  return node;
}

/**
 * Resolves one node (and, recursively, its subtree) into export-ready
 * form. `path` is this node's own child-index path from the top of the
 * nearest enclosing component root (see InstanceOverride's doc comment
 * in @reactfig/core — resets at 0 when crossing into a nested instance's
 * referenced root), used to look up any override targeting it.
 */
function resolve(
  doc: DesignDocument,
  node: Node,
  offsetX: number,
  offsetY: number,
  overrides: InstanceOverride[],
  path: number[],
  depth: number
): ResolvedNode {
  const override = overrides.find((o) => o.path.length === path.length && o.path.every((v, i) => v === path[i]));
  const effective = applyOverrideTo(node, override);

  const bounds: Bounds = {
    x: effective.bounds.x + offsetX,
    y: effective.bounds.y + offsetY,
    width: effective.bounds.width,
    height: effective.bounds.height,
  };

  if (depth > 24) {
    // Guards against a malformed/cyclic componentRef chain rather than a
    // stack overflow — deliberately generous (real component nesting in
    // practice is a handful of levels), see docs/adr's "known gaps".
    return { node: effective, bounds, children: [] };
  }

  if (effective.type === "frame" || effective.type === "group") {
    const children = effective.children.map((child, i) =>
      resolve(doc, child, offsetX, offsetY, overrides, [...path, i], depth + 1)
    );
    return { node: effective, bounds, children };
  }

  if (effective.type === "instance") {
    const componentId =
      effective.componentRef.kind === "component" ? effective.componentRef.componentId : effective.componentRef.componentSetId;
    const comp = findComponent(doc, componentId);
    const resolvedRoot =
      comp && effective.componentRef.kind === "variant"
        ? rootOf(comp, effective.componentRef.variantId)
        : comp
          ? rootOf(comp)
          : undefined;

    if (!resolvedRoot) {
      // Unresolved external ref (see @reactfig/core's findUnresolvedExternalRefs)
      // — rendered as an empty labeled placeholder rather than silently
      // dropped, same policy as the Figma-plugin renderer.
      return { node: effective, bounds, children: [] };
    }

    // Re-anchor the referenced root's own (unrelated) absolute bounds so
    // its top-left lands exactly at this instance's bounds.
    const rootOffsetX = bounds.x - resolvedRoot.bounds.x;
    const rootOffsetY = bounds.y - resolvedRoot.bounds.y;
    const resolvedChild = resolve(doc, resolvedRoot, rootOffsetX, rootOffsetY, effective.overrides ?? [], [], depth + 1);
    // The instance node itself carries no drawable content of its own —
    // its resolved child *is* what gets drawn, at the instance's bounds.
    return { node: effective, bounds, children: [resolvedChild] };
  }

  // text / shape / image — leaf nodes, no children.
  return { node: effective, bounds, children: [] };
}

/** Resolves a component/variant root node into a fully expanded, export-root-relative tree. */
export function resolveRoot(doc: DesignDocument, root: Node): ResolvedNode {
  return resolve(doc, root, -root.bounds.x, -root.bounds.y, [], [], 0);
}

export function resolveColor(color: TokenOr<Color>): Color {
  if ("token" in color) {
    // v1: tokens are informational only outside Figma too — see
    // core/src/types.ts's TokenOr doc comment. A visual export has no
    // token registry to resolve against, so it falls back to a neutral
    // mid-gray rather than fabricating a color, same "honest gap" policy
    // used elsewhere (e.g. unembedded assets).
    return { r: 0.5, g: 0.5, b: 0.5, a: 1 };
  }
  return color;
}

export function cssColor(color: TokenOr<Color>): string {
  const c = resolveColor(color);
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  return `rgba(${r}, ${g}, ${b}, ${c.a})`;
}

export function firstSolidFill(fills: Fill[] | undefined): TokenOr<Color> | undefined {
  const solid = fills?.find((f) => f.type === "solid");
  return solid?.type === "solid" ? solid.color : undefined;
}
