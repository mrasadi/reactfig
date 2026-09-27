/// <reference types="@figma/plugin-typings" />
import type { ComponentDef, ComponentProperty, ComponentSet, DesignDocument, Node as IRNode } from "@reactfig/core";
import type { RenderContext } from "./types.js";
import { safeSize } from "./geometry.js";
import { variantNodeName } from "./naming.js";
import { applyFills, applyStrokes, applyCornerRadius, applyEffects, applyOpacity } from "./style.js";
import { applyLayout } from "./layout.js";
import { createImagePaintOrNull, placeholderFill } from "./assets.js";
import { renderChildrenInto } from "./renderNode.js";

/**
 * Pass 1 of the two-pass rendering order (docs/figma-plugin/
 * feasibility.md, "Rendering order"): builds every top-level component
 * definition and populates `ctx.componentIndex` before pass 2 (page
 * content, which may contain Instances referencing these) runs.
 *
 * That guarantee has to hold *within* this function too, not just
 * relative to pass 2: a component's own root can itself contain Instance
 * nodes referencing a *sibling* component (e.g. SessionCard's root
 * instantiates Avatar/Badge/Button) — and since mergeDesignDocuments
 * always places the primary first in `document.components`, that sibling
 * reference is essentially guaranteed to point at something later in this
 * same array for any merged document. So this runs in two separate
 * sub-passes: every component/variant shell is created and registered in
 * `ctx.componentIndex` first (sub-pass A), and only once every id is
 * resolvable does any of them get their actual content populated
 * (sub-pass B). A single combined loop — create-then-immediately-populate,
 * one entry at a time — previously left every component after the first
 * one still unregistered at the exact moment an earlier component's body
 * needed to resolve them, which is what produced "Instance ... is not
 * defined in this artifact" for every non-primary component in every
 * merged import, unconditionally.
 *
 * Sub-pass B itself further populates in dependency order, not array
 * order: `componentNode.createInstance()` mirrors whatever children the
 * master already has *at that call* (same as real Figma — it doesn't
 * retroactively pick up content added to the master afterward), so
 * populating comp_dashboard (which instantiates comp_stat_card) before
 * comp_stat_card itself has content would silently render every nested
 * StatCard instance empty, even though the "is not defined" warning
 * above doesn't fire (the id IS defined — sub-pass A already created its
 * shell — it's just still contentless).
 */
export async function buildComponents(document: DesignDocument, ctx: RenderContext, container: FrameNode): Promise<void> {
  const plainComponents: Array<{ entry: ComponentDef & { kind: "component" }; node: ComponentNode }> = [];
  const componentSets: Array<{ entry: ComponentSet; variants: Array<{ variant: ComponentSet["variants"][number]; node: ComponentNode }> }> = [];

  // Sub-pass A — shells only: create each ComponentNode, name it, and
  // register it in ctx.componentIndex. No content yet, so nothing here
  // can trigger an Instance lookup.
  for (const entry of document.components) {
    if (entry.kind === "component") {
      const node = ctx.figmaApi.createComponent();
      container.appendChild(node);
      node.name = entry.name;
      ctx.componentIndex.set(entry.id, node);
      plainComponents.push({ entry, node });
    } else {
      const propertyOrder = entry.variantProperties.map((v) => v.name);
      const variants = entry.variants.map((variant) => {
        const node = ctx.figmaApi.createComponent();
        container.appendChild(node);
        node.name = variantNodeName(variant.propertyValues, propertyOrder);
        ctx.componentIndex.set(`${entry.id}:${variant.id}`, node);
        return { variant, node };
      });
      componentSets.push({ entry, variants });
    }
  }

  // Sub-pass B — content: every id in this document is now resolvable
  // via ctx.componentIndex (so nothing here can hit "not defined in this
  // artifact"), but a resolvable-but-still-empty master is not enough
  // for correctness: `componentNode.createInstance()` mirrors whatever
  // children the master already has *at that exact call*, not
  // retroactively — same as real Figma. So a component whose own root
  // instantiates another component (e.g. Dashboard's root instantiates
  // StatCard, StatCard's own text content lives inside StatCard's
  // master) must have that other component's content populated FIRST,
  // regardless of which one appears earlier in document.components
  // (mergeDesignDocuments always puts the primary — typically the
  // outermost, most-dependent one — first). Populate in dependency order
  // (each component's own referenced components before itself) rather
  // than array order.
  const byId = new Map<string, { entry: ComponentDef & { kind: "component" }; node: ComponentNode } | { entry: ComponentSet; variants: Array<{ variant: ComponentSet["variants"][number]; node: ComponentNode }> }>();
  for (const p of plainComponents) byId.set(p.entry.id, p);
  for (const s of componentSets) byId.set(s.entry.id, s);

  const dependenciesOf = new Map<string, Set<string>>();
  for (const [id, target] of byId) {
    const ids = new Set<string>();
    const roots = "node" in target ? [target.entry.root] : target.variants.map((v) => v.variant.root);
    for (const root of roots) collectReferencedComponentIds(root, ids);
    dependenciesOf.set(id, ids);
  }

  const populated = new Set<string>();
  const populating = new Set<string>(); // cycle guard — a real React tree shouldn't produce one (e.g. a recursive TreeNode/Accordion pattern could), but don't hang if it does
  async function populate(id: string): Promise<void> {
    if (populated.has(id)) return;
    if (populating.has(id)) {
      ctx.warnings.push(
        `Component "${byId.get(id)?.entry.name ?? id}" is part of a circular instance reference (it — directly or transitively — instantiates a component that instantiates it back). Rendering it before its own dependency is fully populated, so any nested instance completing that cycle may render with missing/stale content.`
      );
      return;
    }
    populating.add(id);
    for (const dep of dependenciesOf.get(id) ?? []) {
      if (byId.has(dep)) await populate(dep);
    }
    const target = byId.get(id);
    if (target) {
      if ("node" in target) {
        await populateComponentRoot(target.node, target.entry.root, ctx);
        applyComponentProperties(target.node, target.entry.properties, ctx, target.entry.name);
      } else {
        for (const { variant, node } of target.variants) {
          await populateComponentRoot(node, variant.root, ctx);
        }
        const setNode = ctx.figmaApi.combineAsVariants(
          target.variants.map((v) => v.node),
          container
        );
        setNode.name = target.entry.name;
        applyComponentProperties(setNode, target.entry.properties, ctx, target.entry.name);
      }
    }
    populating.delete(id);
    populated.add(id);
  }
  for (const id of byId.keys()) await populate(id);
}

/**
 * Every component id an IR subtree references via an `instance` node —
 * used to populate components in dependency order (see the sub-pass B
 * comment above). Deliberately shallow: it scans this component's own
 * tree only, not into whatever a nested instance's own referenced
 * component further contains — each component gets its own top-level
 * call from `buildComponents`, so transitively-nested dependencies are
 * covered by that component's own entry in `dependenciesOf`, not by
 * chasing them here too.
 */
function collectReferencedComponentIds(node: IRNode, ids: Set<string>): void {
  if (node.type === "instance") {
    ids.add(node.componentRef.kind === "component" ? node.componentRef.componentId : node.componentRef.componentSetId);
    return;
  }
  if (node.type === "frame" || node.type === "group") {
    for (const child of node.children) collectReferencedComponentIds(child, ids);
  }
}

function applyComponentProperties(
  node: ComponentNode | ComponentSetNode,
  properties: ComponentProperty[] | undefined,
  ctx: RenderContext,
  ownerName: string
): void {
  for (const prop of properties ?? []) {
    if (prop.type === "instanceSwap") {
      ctx.warnings.push(
        `Component "${ownerName}": property "${prop.name}" is type instanceSwap, which requires a default component key not present in the Design IR — skipped.`
      );
      continue;
    }
    const figmaType = prop.type === "boolean" ? "BOOLEAN" : "TEXT";
    const defaultValue = prop.type === "boolean" ? Boolean(prop.defaultValue ?? false) : String(prop.defaultValue ?? "");
    node.addComponentProperty(prop.name, figmaType, defaultValue);
  }
}

/**
 * Populates an already-created ComponentNode with the IR root node's own
 * visual properties and children. ComponentNode "behaves like a
 * FrameNode" (verified — see docs/figma-plugin/feasibility.md), so a
 * `frame`-rooted component maps directly; other root types get a
 * documented simplified fallback (see the `text`/`shape`/`group`/
 * `instance` cases) since Figma components must fundamentally be
 * frame-like — these fallbacks are exercised less thoroughly than the
 * frame/image paths, which match every real fixture this project ships.
 */
async function populateComponentRoot(container: ComponentNode, root: IRNode, ctx: RenderContext): Promise<void> {
  const size = safeSize(root.bounds);
  container.resize(size.width, size.height);
  const context = `Component root "${root.name}"`;

  switch (root.type) {
    case "frame": {
      applyOpacity(container, root.opacity);
      applyFills(container, root.fills, ctx, context);
      applyStrokes(container, root.strokes, ctx, context, root.strokeWeights);
      applyCornerRadius(container, root.cornerRadius);
      applyEffects(container, root.effects);
      // Same default-clip concern as renderNode.ts's renderFrame — see
      // docs/adr/0031. A component root is exactly as likely to have
      // real content extending past its own nominal bounds (capture
      // rounding, negative margins, decorative overflow) as any nested
      // frame is.
      container.clipsContent = root.clipsContent ?? false;
      const { stretchChildren } = applyLayout(container, root.layout);
      await renderChildrenInto(root.children, root.bounds, container, ctx, stretchChildren);
      return;
    }
    case "image": {
      const paint = createImagePaintOrNull(root.assetId, undefined, ctx, context) ?? placeholderFill();
      container.fills = [paint];
      applyCornerRadius(container, root.cornerRadius);
      applyOpacity(container, root.opacity);
      return;
    }
    case "shape": {
      ctx.warnings.push(`${context}: a Shape node as a component's direct root is approximated as a frame (Figma components must be frame-like).`);
      applyOpacity(container, root.opacity);
      applyFills(container, root.fills, ctx, context);
      applyStrokes(container, root.strokes, ctx, context);
      if (root.shape === "rectangle") applyCornerRadius(container, root.cornerRadius);
      applyEffects(container, root.effects);
      return;
    }
    case "group": {
      applyOpacity(container, root.opacity);
      container.layoutMode = "NONE";
      await renderChildrenInto(root.children, root.bounds, container, ctx, false);
      return;
    }
    case "text": {
      ctx.warnings.push(`${context}: a bare Text node as a component's direct root is wrapped in a container frame (Figma components must be frame-like).`);
      await renderChildrenInto([root], root.bounds, container, ctx, false);
      return;
    }
    case "instance": {
      ctx.warnings.push(`${context}: an Instance node as a component's direct root is not supported — rendered as an empty frame.`);
      return;
    }
  }
}
