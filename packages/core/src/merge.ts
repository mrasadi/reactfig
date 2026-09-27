import type { AssetRef, ComponentDef, ComponentSet, DesignDocument, Fill, InstanceOverride, Node } from "./types.js";

/**
 * Mirrors slug() in packages/analyzer/src/ai/buildDesignIR.ts — the
 * function that turns a component's display name into both a
 * ComponentDef's id (`comp_${slug(name)}`) and, for a nested component
 * boundary the analyzer chose not to resolve, the placeholder ref
 * `external:${name}` (see docs/adr/0008-ai-orchestration.md, "Known
 * limitations"). Duplicated rather than imported because core does not
 * depend on analyzer (dependency direction is the other way); the two
 * MUST stay byte-for-byte identical or resolution below silently stops
 * matching. Pinned by a same-output test in test/merge.test.ts.
 */
function slug(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export interface MergeDesignDocumentsResult {
  document: DesignDocument;
  /**
   * `external:<Name>` refs (ADR 0008) that none of the supplied dependency
   * documents resolved. Still present as `external:*` in the output
   * document — design-ir/v1 doesn't enforce referential integrity on
   * componentId (ADR 0008), so this isn't a validation failure — but
   * callers should usually warn on it, since it means the artifact will
   * render that instance as a placeholder.
   */
  unresolvedExternalRefs: string[];
  /**
   * Component ids that appeared in more than one input document (primary
   * or dependencies). Only the first occurrence is kept in the merged
   * document, and — for a dependency that contributes no new component at
   * all (every one of its components is a duplicate) — its assets are
   * dropped too, rather than being left unreferenced in the merged
   * document. This is expected when the same dependency is legitimately
   * passed more than once (e.g. two different primaries both depending on
   * Avatar in one batch); surfaced here so a caller can tell that from an
   * accidental duplicate.
   */
  duplicateComponentIds: string[];
}

/**
 * Combines a primary Design IR document (e.g. a SessionCard generated via
 * generate_design_ir) with one or more dependency documents (e.g. Avatar,
 * Badge, Button — each generated the same way, pointed at that component's
 * own source file) into a single document.
 *
 * The primary's nested-instance placeholder refs — `external:<Name>`, the
 * documented consequence of buildDesignIR.ts treating a nested component
 * boundary as "a separate analysis, not solved here" (ADR 0008) — are
 * rewritten to a real componentRef pointing at a matching dependency, when
 * one is supplied: `{ kind: "component", componentId }` if the match is a
 * plain ComponentDef, or `{ kind: "variant", componentSetId, variantId }`
 * (defaulting to the match's first variant, same fallback buildDesignIR.ts
 * itself uses for a top-level componentSet's page instance) if the match
 * is a ComponentSet — the figma-plugin renderer's componentIndex only ever
 * indexes a componentSet's *variants*, never a bare id for the set itself
 * (see packages/figma-plugin/src/code/render/components.ts), so resolving
 * to `{ kind: "component", componentId: <componentSet id> }` would validate
 * but still render as an unresolved placeholder.
 *
 * This function does not re-run capture or analysis; it only combines
 * documents that were already independently generated. It also does not
 * recursively expand instances — an instance's componentRef is a pointer
 * to another entry in `components`, never inlined — so it's unaffected by,
 * and doesn't need to guard against, circular references between
 * dependencies.
 *
 * Node ids and asset ids are namespaced per dependency (prefixed by that
 * dependency's position in the array) because each generate_design_ir call
 * restarts its own id counters from zero, so two independently generated
 * documents are very likely to reuse ids like `node_frame_0` or `asset_0`.
 * This includes asset ids referenced from a `Fill` (e.g. a CSS
 * background-image, not just a direct `<img>`/ImageNode), which is easy to
 * miss since it's nested inside `fills[]` rather than a top-level field.
 * The primary document's own ids are left untouched. Component ids are
 * intentionally NOT namespaced — they're how resolution below matches an
 * `external:<Name>` ref to the right dependency in the first place, and
 * they're already deterministic per component name (`comp_${slug(name)}`)
 * across separate generate_design_ir calls for the same component.
 */
export function mergeDesignDocuments(
  primary: DesignDocument,
  dependencies: DesignDocument[],
  instanceOverrides?: InstanceOverridesInput
): MergeDesignDocumentsResult {
  const components: (ComponentDef | ComponentSet)[] = [];
  const componentById = new Map<string, ComponentDef | ComponentSet>();
  const duplicateComponentIds = new Set<string>();
  const assets: AssetRef[] = primary.assets.map((a) => ({ ...a }));

  function addComponent(comp: ComponentDef | ComponentSet): void {
    if (componentById.has(comp.id)) {
      duplicateComponentIds.add(comp.id);
      return;
    }
    componentById.set(comp.id, comp);
    components.push(comp);
  }

  for (const comp of primary.components.map(cloneComponent)) addComponent(comp);

  dependencies.forEach((dep, depIndex) => {
    const namespace = `dep${depIndex}_`;
    const assetIdMap = new Map<string, string>();
    for (const asset of dep.assets) assetIdMap.set(asset.id, `${namespace}${asset.id}`);

    const namespacedComponents = dep.components.map((c) => namespaceComponent(cloneComponent(c), namespace, assetIdMap));
    const hasAnyNewComponent = namespacedComponents.some((c) => !componentById.has(c.id));
    if (!hasAnyNewComponent) {
      // Every component this dependency would have contributed is already
      // present (e.g. the same dependency document supplied twice, or two
      // dependencies both containing the same nested component) — skip its
      // assets too, or they'd end up in the merged document unreferenced
      // by anything. addComponent() below is still per-component-safe for
      // the rarer mixed case (a multi-component dependency where only some
      // of its components are duplicates); this is just the common-case
      // fast path so a fully-duplicate dependency doesn't leak assets.
      for (const c of namespacedComponents) duplicateComponentIds.add(c.id);
      return;
    }

    for (const asset of dep.assets) assets.push({ ...asset, id: assetIdMap.get(asset.id)! });
    for (const comp of namespacedComponents) addComponent(comp);
  });

  const unresolvedExternalRefs = new Set<string>();
  for (const comp of components) rewriteExternalRefs(comp, componentById, unresolvedExternalRefs);

  if (instanceOverrides) {
    // Only the primary document's own component defs carry real instance
    // nodes a caller could plausibly be addressing by id — a dependency
    // is a component library, not a page composition, so instance ids
    // from the caller's perspective (e.g. "the second StatCard on the
    // Dashboard") only ever originate from primary. Primary's components
    // are always first in `components` (addComponent() above), so this
    // mutates them there, in place, on the already-cloned/merged entries.
    for (let i = 0; i < primary.components.length; i++) {
      applyInstanceOverrides(components[i], instanceOverrides);
    }
  }

  return {
    document: { ...primary, components, assets },
    unresolvedExternalRefs: [...unresolvedExternalRefs],
    duplicateComponentIds: [...duplicateComponentIds],
  };
}

function cloneComponent(comp: ComponentDef | ComponentSet): ComponentDef | ComponentSet {
  return JSON.parse(JSON.stringify(comp)) as ComponentDef | ComponentSet;
}

function namespaceComponent(comp: ComponentDef | ComponentSet, namespace: string, assetIdMap: Map<string, string>): ComponentDef | ComponentSet {
  if (comp.kind === "component") {
    return { ...comp, root: namespaceNode(comp.root, namespace, assetIdMap) };
  }
  return {
    ...comp,
    variants: comp.variants.map((v) => ({ ...v, root: namespaceNode(v.root, namespace, assetIdMap) })),
  };
}

function namespaceFills(fills: Fill[] | undefined, assetIdMap: Map<string, string>): Fill[] | undefined {
  return fills?.map((f) => (f.type === "image" ? { ...f, assetId: assetIdMap.get(f.assetId) ?? f.assetId } : f));
}

function namespaceNode(node: Node, namespace: string, assetIdMap: Map<string, string>): Node {
  const id = `${namespace}${node.id}`;
  switch (node.type) {
    case "frame":
      return {
        ...node,
        id,
        fills: namespaceFills(node.fills, assetIdMap),
        children: node.children.map((c) => namespaceNode(c, namespace, assetIdMap)),
      };
    case "group":
      return { ...node, id, children: node.children.map((c) => namespaceNode(c, namespace, assetIdMap)) };
    case "shape":
      return { ...node, id, fills: namespaceFills(node.fills, assetIdMap) };
    case "text":
      return { ...node, id, fills: namespaceFills(node.fills, assetIdMap) };
    case "image":
      return { ...node, id, assetId: assetIdMap.get(node.assetId) ?? node.assetId };
    case "instance":
      return { ...node, id };
  }
}

/**
 * Scans every component in a document for instance componentRefs still in
 * the unresolved `external:<Name>` placeholder form (ADR 0008) and returns
 * the distinct raw refs found (e.g. `["external:SessionCard"]`), in
 * first-encountered order. `[]` means the document is safe to export — no
 * instance will render as a Figma placeholder box for this reason.
 *
 * Intended for a caller sitting between "document is about to be exported"
 * and "document was exported" — e.g. export_design_artifact — as a last
 * line of defense: mergeDesignDocuments() already reports refs it couldn't
 * resolve via its own return value, but a document can also reach export
 * having skipped merge entirely (never had a dependency-resolution step
 * run), which this catches regardless of how the unresolved ref got there.
 */
export function findUnresolvedExternalRefs(document: DesignDocument): string[] {
  const found = new Set<string>();
  for (const comp of document.components) {
    const roots = comp.kind === "component" ? [comp.root] : comp.variants.map((v) => v.root);
    for (const root of roots) walk(root);
  }
  return [...found];

  function walk(node: Node): void {
    if (node.type === "instance") {
      if (node.componentRef.kind === "component" && EXTERNAL_REF.test(node.componentRef.componentId)) {
        found.add(node.componentRef.componentId);
      }
      return;
    }
    if (node.type === "frame" || node.type === "group") {
      for (const child of node.children) walk(child);
    }
  }
}

const EXTERNAL_REF = /^external:(.+)$/;

/**
 * Finds the child-index `path` (see `InstanceOverride`) from a
 * component's root down to the descendant node with id `targetNodeId`,
 * transparently crossing into a nested instance's own referenced
 * component when the search passes through one — matching how the path
 * is resolved at render time against a real Figma instance's `.children`.
 *
 * Returns `null` if no descendant (at any crossed depth) has that id.
 * Intended for callers building `instanceOverrides` for
 * `mergeDesignDocuments` without hand-counting child indices — look up
 * the target text/frame node's id once in the source Design IR (e.g. the
 * StatCard component's captured "12" TextNode) and reuse the returned
 * path for every instance that needs a different value there.
 */
export function findNodePath(document: DesignDocument, componentId: string, targetNodeId: string): number[] | null {
  const componentById = new Map(document.components.map((c) => [c.id, c]));
  const root = rootOf(componentById.get(componentId));
  if (!root) return null;
  return search(root);

  /**
   * `variantId`, when given, picks a specific variant out of a
   * ComponentSet — required whenever this is resolving an `instance`
   * node's own `componentRef` (which names the exact variant it points
   * at). Omitted only for the top-level `componentId` call argument,
   * where the caller doesn't have a specific variant in mind; that case
   * falls back to the set's first variant, same as before — callers
   * targeting a specific variant's structure should resolve the
   * ComponentSet + variant themselves and pass that variant's own root
   * id space, or rely on the instance-branch case below, which always
   * has a real `variantId` to use.
   */
  function rootOf(comp: ComponentDef | ComponentSet | undefined, variantId?: string): Node | null {
    if (!comp) return null;
    if (comp.kind === "component") return comp.root;
    const variant = variantId ? comp.variants.find((v) => v.id === variantId) : comp.variants[0];
    return variant?.root ?? null;
  }

  function search(node: Node): number[] | null {
    if (node.id === targetNodeId) return [];
    if (node.type === "frame" || node.type === "group") {
      for (let i = 0; i < node.children.length; i++) {
        const found = search(node.children[i]);
        if (found) return [i, ...found];
      }
    } else if (node.type === "instance") {
      // Crossing into a nested instance's own referenced component is
      // transparent to the path — no index is consumed for the crossing
      // itself (see the InstanceOverride.path doc comment): the index
      // that got the walk *to* this instance node is what its own parent
      // adds, one level up. search(nestedRoot) both matches "the target
      // IS the nested component's root" (returns []) and recurses into
      // its children/further nested instances the same as anywhere else.
      // For a `variant` ref, resolving against the WRONG variant (e.g.
      // always the set's first) would silently walk a different node
      // tree than the one this specific instance actually renders —
      // variants commonly differ in structure (an icon-only extra child,
      // a different wrapper) — so the referenced variantId is honored
      // here, not defaulted away.
      const nestedRoot =
        node.componentRef.kind === "component"
          ? rootOf(componentById.get(node.componentRef.componentId))
          : rootOf(componentById.get(node.componentRef.componentSetId), node.componentRef.variantId);
      if (nestedRoot) {
        const found = search(nestedRoot);
        if (found) return found;
      }
    }
    return null;
  }
}

/**
 * Per-instance content overrides supplied by the caller (see
 * `InstanceOverride`), keyed by the target instance node's own `id` as it
 * appears in the *primary* document passed to `mergeDesignDocuments` —
 * e.g. `"node_instance_2"` for the first StatCard in Dashboard.tsx's
 * `.map()`-rendered row. Applied to the primary's instance nodes only
 * (dependency documents are components, not instances of themselves), so
 * this is how `merge_design_ir_checkpoints` resolves the "all instances
 * identical" failure mode: the merge step itself has no opinion on what
 * data belongs on which instance, so the caller supplies it.
 */
export type InstanceOverridesInput = Record<string, InstanceOverride[]>;

function applyInstanceOverrides(comp: ComponentDef | ComponentSet, instanceOverrides: InstanceOverridesInput): void {
  const roots = comp.kind === "component" ? [comp.root] : comp.variants.map((v) => v.root);
  for (const root of roots) walk(root);

  function walk(node: Node): void {
    if (node.type === "instance") {
      const overrides = instanceOverrides[node.id];
      if (overrides && overrides.length > 0) {
        node.overrides = [...(node.overrides ?? []), ...overrides];
      }
      return;
    }
    if (node.type === "frame" || node.type === "group") {
      for (const child of node.children) walk(child);
    }
  }
}

function rewriteExternalRefs(comp: ComponentDef | ComponentSet, componentById: Map<string, ComponentDef | ComponentSet>, unresolved: Set<string>): void {
  const roots = comp.kind === "component" ? [comp.root] : comp.variants.map((v) => v.root);
  for (const root of roots) walk(root);

  function walk(node: Node): void {
    if (node.type === "instance" && node.componentRef.kind === "component") {
      const match = EXTERNAL_REF.exec(node.componentRef.componentId);
      if (match) {
        const resolvedId = `comp_${slug(match[1])}`;
        const target = componentById.get(resolvedId);
        if (!target) {
          unresolved.add(node.componentRef.componentId);
        } else if (target.kind === "component") {
          node.componentRef = { kind: "component", componentId: target.id };
        } else {
          // ComponentSet: the renderer's componentIndex only indexes
          // `${setId}:${variantId}` pairs, never a bare set id (see
          // components.ts) — a "component"-kind ref to a set id would
          // validate but never resolve. Default to the first variant,
          // same fallback buildDesignIR.ts's buildPageInstance() uses.
          node.componentRef = { kind: "variant", componentSetId: target.id, variantId: target.variants[0].id };
        }
      }
      return;
    }
    if (node.type === "frame" || node.type === "group") {
      for (const child of node.children) walk(child);
    }
  }
}
// ---------------------------------------------------------------------------
// Auto-deriving instanceOverrides from raw per-instance data
// ---------------------------------------------------------------------------

/**
 * Literal field values for one rendered instance, e.g. one `.map()` item —
 * `{ label: "Sessions this week", value: "12", tone: "neutral" }`. Only
 * string/number/boolean fields are used; anything else is ignored.
 */
export type PerInstanceDataItem = Record<string, unknown>;

export interface BuildInstanceOverridesResult {
  instanceOverrides: InstanceOverridesInput;
  /**
   * New `AssetRef` entries created for image fields (e.g. one per distinct
   * SessionCard avatar photo beyond whichever one was already captured).
   * The caller must append these to the merged document's top-level
   * `assets` array — `buildInstanceOverridesFromPerInstanceData` only
   * derives the overrides, it doesn't mutate the document it was given.
   * export_design_artifact's existing `fetchAssets` step then fetches
   * these the same as any other asset, since each `path` here is a real
   * http(s) URL (see below).
   */
  newAssets: AssetRef[];
  /**
   * Non-fatal problems hit while deriving overrides — e.g. a component
   * name with no matching component in the document, a field whose value
   * doesn't match any captured text node or image asset, or an
   * instance-count mismatch. The caller (merge_design_ir_checkpoints)
   * surfaces these directly instead of silently merging with partial or
   * no overrides for that component — see Issue.md's follow-up report: a
   * caller manually building `instanceOverrides` from `perInstanceData`
   * got the shape wrong (arrays of `{path, characters}` vs. plain field
   * objects) and had no signal beyond "the artifact contains default
   * data"; deriving it here removes that translation step entirely.
   */
  warnings: string[];
  /**
   * `{ instanceNodeId: variantId }` reassignments for instances whose
   * target component turned out to be a componentSet (ADR 0019 multi-
   * variant capture) — see `assignVariantsFromPerInstanceData`'s doc
   * comment for why this is needed at all: `mergeDesignDocuments`'s
   * external-ref resolution has no per-instance information, so it
   * defaults every instance of a given componentSet to `variants[0]`.
   * Apply with `applyVariantAssignments` against whichever merged
   * document is final — instance ids are stable across a repeated merge
   * of the same primary/dependencies, so this map remains valid even if
   * the caller re-merges after combining derived + explicit overrides.
   */
  variantAssignments: Record<string, string>;
}

/**
 * Turns raw per-instance field data — the natural shape
 * `extractMappedDataRefs` and `inspect_component_dependency_tree`'s
 * `mappedDataRefs` already produce, e.g.
 * `{ StatCard: [{label:"Sessions this week", value:"12", tone:"neutral"}, ...] }`
 * — into the `InstanceOverridesInput` `mergeDesignDocuments` actually
 * consumes (`Record<instanceNodeId, InstanceOverride[]>`), without the
 * caller having to hand-resolve instance node ids or text-node paths.
 *
 * How it works, per componentTag in `perInstanceData`:
 *  1. Finds the named component in `allComponents` (post external-ref
 *     resolution — pass the *merged* document's `components`, not a
 *     pre-merge document, or an instance originally referenced via
 *     `external:<Name>` won't resolve).
 *  2. Treats `items[0]` as the "reference" item — the one whose values are
 *     most likely to already be baked into that component's own captured
 *     root (generate_design_ir typically captures whichever DOM element a
 *     selector matched first — see generate_design_ir's own warning about
 *     a selector matching more than one element). For each of its literal
 *     fields:
 *       - First tries to find a captured TextNode whose `characters`
 *         matches the value, and resolves its structural `path` via
 *         `findNodePath` — one path per field, reusable across every
 *         instance since it's relative to the component's own root, not
 *         any particular instance.
 *       - If that fails and the value looks like a relative asset path
 *         (e.g. SessionCard's `avatarSrc: "/avatars/amir.png"`), tries to
 *         find a captured ImageNode whose asset's `path` (the real
 *         http(s) URL generate_design_ir resolved it to at capture time —
 *         see exportDesignArtifactTool's own use of the same field) ends
 *         with that relative value. On a match, every other item's value
 *         for that field gets its own new asset registered under the same
 *         URL base (e.g. `.../avatars/sara.png`, `.../avatars/dana.png`)
 *         — this is what actually fixes "every SessionCard shows the same
 *         learner's photo", not just their names.
 *  3. Finds every `instance` node in `primaryComponents` that references
 *     this component, in document order, and pairs them positionally with
 *     `items` — instance i gets `items[i]`'s values at each resolved path.
 *
 * A field that matches neither a text node nor an image asset (a value
 * baked into a `tone`-driven fill/class rather than its own text, or a
 * numeric field folded into a larger string like `Score: 7/9`) is skipped
 * for every instance, not just item[0], and reported in `warnings` rather
 * than thrown — a partial override is still far better than none.
 */
export function buildInstanceOverridesFromPerInstanceData(
  primaryComponents: (ComponentDef | ComponentSet)[],
  allComponents: (ComponentDef | ComponentSet)[],
  assets: AssetRef[],
  perInstanceData: Record<string, PerInstanceDataItem[]>
): BuildInstanceOverridesResult {
  const byName = new Map(allComponents.map((c) => [c.name, c]));
  const assetsById = new Map(assets.map((a) => [a.id, a]));
  const documentStub = { components: allComponents } as DesignDocument;
  const warnings: string[] = [];
  const instanceOverrides: InstanceOverridesInput = {};
  const newAssets: AssetRef[] = [];
  const newAssetIdByUrl = new Map<string, string>(); // dedup across fields/components in the same call
  const variantAssignments: Record<string, string> = {};

  for (const [tag, items] of Object.entries(perInstanceData)) {
    if (items.length === 0) continue;

    const targetComp = byName.get(tag);
    if (!targetComp) {
      warnings.push(`buildInstanceOverridesFromPerInstanceData: no component named "${tag}" found in the merged document — skipped.`);
      continue;
    }

    const root = componentRoot(targetComp);
    if (!root) {
      warnings.push(`buildInstanceOverridesFromPerInstanceData: "${tag}" has no root node to search — skipped.`);
      continue;
    }

    const referenceItem = items[0];
    type FieldMatch = { kind: "text"; path: number[] } | { kind: "image"; path: number[]; nodeId: string; baseUrl: string; originalAssetId: string; originalUrl: string; mimeType: string; width?: number; height?: number };
    const fieldMatches: Record<string, FieldMatch> = {};
    const unmatchedFields: string[] = [];

    for (const [field, value] of Object.entries(referenceItem)) {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;

      const textMatch = findNode(root, allComponents, (n) => n.type === "text" && n.characters === String(value));
      if (textMatch) {
        const path = findNodePath(documentStub, targetComp.id, textMatch.id);
        if (path) {
          fieldMatches[field] = { kind: "text", path };
          continue;
        }
      }

      // Exact match: an ImageNode whose already-captured asset URL happens
      // to end with this field's value. Works when the reference item's
      // instance is the one whose photo actually got captured — but for a
      // component reused across contexts (Avatar inside both Header and
      // every SessionCard — see multiContextProps), only ONE checkpoint
      // ever gets captured for it, and it may not correspond to any
      // SESSIONS item at all (e.g. it was captured from Header, whose
      // avatarSrc is a different photo entirely). The image-slot fallback
      // right below this loop handles that case.
      if (typeof value === "string" && value.length > 0) {
        const imageMatch = findExactImageMatch(root, allComponents, assetsById, value);
        if (imageMatch) {
          const path = findNodePath(documentStub, targetComp.id, imageMatch.nodeId);
          if (path) {
            fieldMatches[field] = { kind: "image", path, nodeId: imageMatch.nodeId, ...toImageFieldMatchBase(imageMatch.asset) };
            continue;
          }
        }
      }

      unmatchedFields.push(field);
    }

    // Image-slot fallback: an unmatched field whose value looks like an
    // image path, paired with the component's one remaining (unclaimed)
    // ImageNode, if there's exactly one candidate on each side — no
    // ambiguity to resolve. The URL base comes from that ImageNode's own
    // captured asset's origin (protocol+host), not from a value match,
    // since nothing captured is expected to match a reused-elsewhere
    // component's checkpoint. This is what makes per-SessionCard avatar
    // photos actually swap even though Avatar's one checkpoint happened to
    // be captured from Header, not any particular session.
    const imageLikeUnmatched = unmatchedFields.filter((f) => typeof referenceItem[f] === "string" && looksLikeImagePath(referenceItem[f] as string));
    if (imageLikeUnmatched.length === 1) {
      const claimedNodeIds = new Set(Object.values(fieldMatches).flatMap((m) => (m.kind === "image" ? [m.nodeId] : [])));
      const candidates = findAllImageNodes(root, allComponents).filter((c) => !claimedNodeIds.has(c.id));
      if (candidates.length === 1) {
        const asset = assetsById.get(candidates[0].assetId);
        if (asset) {
          const path = findNodePath(documentStub, targetComp.id, candidates[0].id);
          if (path) {
            const field = imageLikeUnmatched[0];
            fieldMatches[field] = { kind: "image", path, nodeId: candidates[0].id, ...toImageFieldMatchBase(asset) };
            unmatchedFields.splice(unmatchedFields.indexOf(field), 1);
          }
        }
      }
    }

    if (unmatchedFields.length > 0) {
      warnings.push(
        `buildInstanceOverridesFromPerInstanceData: "${tag}" — could not find a captured text node or image asset matching field(s) ${unmatchedFields.join(", ")} (checked against the first item's values, and — for image-path-looking values — against the component's own unclaimed image slots); these fields won't be overridden on any instance.`
      );
    }

    // Independent of text/image field matching above — a componentTag
    // whose fields only ever describe a variant axis (e.g. StatCard's
    // `tone`, with no field of its own baked into a captured text node)
    // still needs its instances' variantId reassigned, so this runs even
    // when fieldMatches ends up empty for every item.
    Object.assign(variantAssignments, assignVariantsFromPerInstanceData(targetComp, primaryComponents, items, tag, warnings));

    if (Object.keys(fieldMatches).length === 0) {
      warnings.push(`buildInstanceOverridesFromPerInstanceData: "${tag}" — no field matched any captured text node or image asset at all; no overrides produced for it.`);
      continue;
    }

    const instanceIds = findInstanceNodeIds(primaryComponents, targetComp.id);
    if (instanceIds.length === 0) {
      warnings.push(`buildInstanceOverridesFromPerInstanceData: perInstanceData supplied for "${tag}" but no instance of it was found in the primary document — nothing to override.`);
      continue;
    }
    if (instanceIds.length !== items.length) {
      warnings.push(
        `buildInstanceOverridesFromPerInstanceData: "${tag}" has ${instanceIds.length} instance(s) in the primary document but perInstanceData supplied ${items.length} item(s) — overriding the first ${Math.min(instanceIds.length, items.length)}.`
      );
    }

    const n = Math.min(instanceIds.length, items.length);
    for (let i = 0; i < n; i++) {
      const item = items[i];
      const overrides: InstanceOverride[] = [];
      for (const [field, match] of Object.entries(fieldMatches)) {
        const value = item[field];
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;

        if (match.kind === "text") {
          overrides.push({ path: match.path, characters: String(value) });
          continue;
        }

        // image field
        const url = resolveImageUrl(match.baseUrl, String(value));
        let assetId: string;
        if (url === match.originalUrl) {

          assetId = match.originalAssetId;
        } else if (newAssetIdByUrl.has(url)) {
          assetId = newAssetIdByUrl.get(url)!;
        } else {
          assetId = `asset_${slug(tag)}_${slug(field)}_${i}`;
          newAssetIdByUrl.set(url, assetId);
          newAssets.push({ id: assetId, path: url, mimeType: match.mimeType, width: match.width, height: match.height });
        }
        overrides.push({ path: match.path, fills: [{ type: "image", assetId }] });
      }
      if (overrides.length > 0) {
        instanceOverrides[instanceIds[i]] = [...(instanceOverrides[instanceIds[i]] ?? []), ...overrides];
      }
    }
  }

  return { instanceOverrides, newAssets, warnings, variantAssignments };
}

function componentRoot(comp: ComponentDef | ComponentSet): Node | null {
  return comp.kind === "component" ? comp.root : (comp.variants[0]?.root ?? null);
}

/**
 * Finds the first descendant node matching `predicate`, searching `root`'s
 * descendants and transparently crossing into nested instances' own
 * referenced components (same crossing rule as `findNodePath`'s search,
 * since a target field's value may live inside a nested instance — e.g. a
 * SessionCard's own nested Badge text, or a nested Avatar image).
 */
function findNode(root: Node, allComponents: (ComponentDef | ComponentSet)[], predicate: (node: Node) => boolean): Node | null {
  const componentById = new Map(allComponents.map((c) => [c.id, c]));
  return search(root);

  function search(node: Node): Node | null {
    if (predicate(node)) return node;
    if (node.type === "frame" || node.type === "group") {
      for (const child of node.children) {
        const found = search(child);
        if (found) return found;
      }
    } else if (node.type === "instance") {
      const target = node.componentRef.kind === "component" ? componentById.get(node.componentRef.componentId) : componentById.get(node.componentRef.componentSetId);
      const nestedRoot = target
        ? target.kind === "component"
          ? target.root
          : (target.variants.find((v) => v.id === (node.componentRef as { variantId: string }).variantId) ?? target.variants[0])?.root
        : null;
      if (nestedRoot) {
        const found = search(nestedRoot);
        if (found) return found;
      }
    }
    return null;
  }
}

/** Every reachable ImageNode in `root`, crossing nested instances (same rule as `findNode`). */
function findAllImageNodes(root: Node, allComponents: (ComponentDef | ComponentSet)[]): Array<{ id: string; assetId: string }> {
  const componentById = new Map(allComponents.map((c) => [c.id, c]));
  const found: Array<{ id: string; assetId: string }> = [];
  walk(root);
  return found;

  function walk(node: Node): void {
    if (node.type === "image") {
      found.push({ id: node.id, assetId: node.assetId });
      return;
    }
    if (node.type === "frame" || node.type === "group") {
      for (const child of node.children) walk(child);
    } else if (node.type === "instance") {
      const target = node.componentRef.kind === "component" ? componentById.get(node.componentRef.componentId) : componentById.get(node.componentRef.componentSetId);
      const nestedRoot = target
        ? target.kind === "component"
          ? target.root
          : (target.variants.find((v) => v.id === (node.componentRef as { variantId: string }).variantId) ?? target.variants[0])?.root
        : null;
      if (nestedRoot) walk(nestedRoot);
    }
  }
}

/** An ImageNode whose currently-assigned asset's URL ends with `value` (normalized to a leading slash). */
function findExactImageMatch(
  root: Node,
  allComponents: (ComponentDef | ComponentSet)[],
  assetsById: Map<string, AssetRef>,
  value: string
): { nodeId: string; asset: AssetRef } | null {
  const normalized = value.startsWith("/") ? value : `/${value}`;
  const match = findNode(root, allComponents, (n) => n.type === "image" && (assetsById.get(n.assetId)?.path.endsWith(normalized) ?? false));
  if (!match || match.type !== "image") return null;
  const asset = assetsById.get(match.assetId);
  return asset ? { nodeId: match.id, asset } : null;
}

const IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp|svg|avif)(\?.*)?$/i;

/** Heuristic for "this field's value is probably meant to become an image asset" — used only as a last-resort fallback when there's exactly one unclaimed image slot to pair it with (see the image-slot fallback above). */
function looksLikeImagePath(value: string): boolean {
  return IMAGE_PATH_RE.test(value) || value.startsWith("http://") || value.startsWith("https://") || value.startsWith("/");
}

/** protocol + host of an http(s) URL, e.g. "http://localhost:5173/avatars/x.png" -> "http://localhost:5173". Null for anything else (data: URI, relative path, malformed). */
function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function toImageFieldMatchBase(asset: AssetRef): { baseUrl: string; originalAssetId: string; originalUrl: string; mimeType: string; width?: number; height?: number } {
  return {
    baseUrl: originOf(asset.path) ?? asset.path,
    originalAssetId: asset.id,
    originalUrl: asset.path,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
  };
}

/** Combines an image field's base URL (an origin, e.g. "http://localhost:5173") with an item's own value (already a full URL, or a "/"-rooted relative path). */
function resolveImageUrl(baseUrl: string, value: string): string {
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  return `${baseUrl}${value.startsWith("/") ? value : `/${value}`}`;
}


function findInstanceNodeIds(components: (ComponentDef | ComponentSet)[], targetComponentId: string): string[] {
  return findInstanceNodesByComponentId(components, targetComponentId).map((n) => n.id);
}

/**
 * Same walk as findInstanceNodeIds, but returns the actual node objects
 * (references into `components`'s own object graph, not copies) — used
 * where a caller needs to mutate the node in place (see
 * `assignVariantsFromPerInstanceData`), not just know which ids exist.
 */
function findInstanceNodesByComponentId(components: (ComponentDef | ComponentSet)[], targetComponentId: string): Extract<Node, { type: "instance" }>[] {
  const nodes: Extract<Node, { type: "instance" }>[] = [];
  for (const comp of components) {
    const roots = comp.kind === "component" ? [comp.root] : comp.variants.map((v) => v.root);
    for (const root of roots) walk(root);
  }
  return nodes;

  function walk(node: Node): void {
    if (node.type === "instance") {
      const refId = node.componentRef.kind === "component" ? node.componentRef.componentId : node.componentRef.componentSetId;
      if (refId === targetComponentId) nodes.push(node);
      return;
    }
    if (node.type === "frame" || node.type === "group") {
      for (const child of node.children) walk(child);
    }
  }
}

/**
 * When a componentTag in `perInstanceData` resolves to a componentSet
 * (i.e. `generate_design_ir`'s multi-variant capture — ADR 0019 — actually
 * discovered and captured variants for it, e.g. StatCard.tone or
 * SessionCard.status), every nested instance of it starts out pointing at
 * the SAME variant: `mergeDesignDocuments`'s external-ref resolution has
 * no per-instance information to go on, so it defaults every instance to
 * `variants[0]` (see the `external:<Name>` resolution branch above). That
 * default is what makes three genuinely different StatCards (or three
 * different SessionCards' nested Badges) all render the first captured
 * variant's own visuals — not a fabricated bug in the variant's own
 * captured data, a bug in *which* already-correct variant each instance
 * points at.
 *
 * This reassigns each instance's `variantId` using the same per-instance
 * `items` perInstanceData already supplies for text/image overrides: if
 * an item's fields include one of the componentSet's own
 * `variantProperties` names (e.g. `tone`, `status`) with a value matching
 * one of that axis's captured variants, that instance's componentRef is
 * repointed to the matching variant — reusing the existing componentSet/
 * variantAxes architecture, never inventing a new one. An item whose
 * value doesn't match any captured variant is left on its current
 * (default) variant and reported in `warnings`, exactly like an unmatched
 * text/image field.
 *
 * Pure — returns a `{ instanceNodeId: variantId }` map rather than
 * mutating in place, because `mergeDesignIrCheckpointsTool` (the only
 * current caller, via `buildInstanceOverridesFromPerInstanceData`) may
 * re-run `mergeDesignDocuments` a second time afterward (once combining
 * derived + explicit `instanceOverrides`) — a fresh clone, which would
 * silently discard an in-place mutation made against the first merge's
 * document. Instance node ids are stable across repeated merges of the
 * same primary/dependencies (cloneComponent never renames them), so the
 * same assignment map is valid to apply once, after whichever merge
 * result is actually final — see `applyVariantAssignments`.
 */
function assignVariantsFromPerInstanceData(
  targetComp: ComponentDef | ComponentSet,
  primaryComponents: (ComponentDef | ComponentSet)[],
  items: PerInstanceDataItem[],
  tag: string,
  warnings: string[]
): Record<string, string> {
  const assignments: Record<string, string> = {};
  if (targetComp.kind !== "componentSet" || targetComp.variantProperties.length === 0) return assignments;

  const instances = findInstanceNodesByComponentId(primaryComponents, targetComp.id);
  const n = Math.min(instances.length, items.length);
  for (let i = 0; i < n; i++) {
    const instance = instances[i];
    if (instance.componentRef.kind !== "variant") continue;
    const item = items[i];

    for (const axis of targetComp.variantProperties) {
      let value = item[axis.name];
      if (typeof value !== "string") {
        // The axis name the model/interpretation step confirmed for this
        // componentSet (e.g. "cardTone") doesn't match any key in this
        // perInstanceData item at all — a real, previously silent gap:
        // axis naming comes from AI interpretation of captured evidence,
        // perInstanceData field naming comes from the raw source data,
        // and nothing guarantees the two ever agree textually, even when
        // they mean the same thing. Falling through to "just leave it on
        // the default variant" here is exactly how EVERY instance of a
        // componentSet silently ends up on variants[0] regardless of its
        // own data — with zero warning, since this isn't the "value
        // didn't match a captured variant" case below, it's "there was no
        // value to check at all."
        //
        // Recovery: look for exactly one field in this item whose VALUE
        // is one of this axis's own already-captured values (e.g. a
        // perInstanceData field named "tone" would still be found even
        // if the axis itself got named "cardTone") — safe, because it
        // only ever matches against values the axis itself already
        // declared as valid, never invents anything new. Ambiguous (more
        // than one candidate) or absent (zero candidates) both fall back
        // to warning and leaving the instance on its current variant,
        // rather than guessing.
        const candidateKeys = Object.keys(item).filter((k) => typeof item[k] === "string" && axis.values.includes(item[k] as string));
        if (candidateKeys.length === 1) {
          value = item[candidateKeys[0]] as string;
        } else if (candidateKeys.length === 0) {
          warnings.push(
            `buildInstanceOverridesFromPerInstanceData: "${tag}" — instance ${i}'s data has no field named "${axis.name}" (this component's captured variant axis) and no field whose value matches one of this axis's known values (${axis.values.join(", ")}) either; left on its current variant. If "${tag}"'s perInstanceData uses a different field name for this axis than the captured componentSet does, rename one to match.`
          );
          continue;
        } else {
          warnings.push(
            `buildInstanceOverridesFromPerInstanceData: "${tag}" — instance ${i}'s data has no field named "${axis.name}", and more than one field (${candidateKeys.join(", ")}) has a value matching this axis's known values (${axis.values.join(", ")}); left on its current variant rather than guessing which one is right.`
          );
          continue;
        }
      }
      const match = targetComp.variants.find((v) => v.propertyValues[axis.name] === value);
      if (!match) {
        warnings.push(`buildInstanceOverridesFromPerInstanceData: "${tag}" — instance ${i} has ${axis.name}="${value}" but no captured variant has that value; left on its current variant.`);
        continue;
      }
      assignments[instance.id] = match.id;
      break; // one matching axis is enough to pick the variant — variantProperties only ever has one axis today (ADR 0019), but this stays correct if that changes since propertyValues is keyed by axis name, not position.
    }
  }
  return assignments;
}

/**
 * Applies a `{ instanceNodeId: variantId }` map (see
 * `assignVariantsFromPerInstanceData`) to a document's own components —
 * the actual mutation step, run once against whichever merge result is
 * final. A no-op for any instance id not in `assignments`, and for any
 * matched node whose componentRef isn't already `kind: "variant"` (a
 * plain, non-variant dependency component has nothing to reassign).
 */
export function applyVariantAssignments(components: (ComponentDef | ComponentSet)[], assignments: Record<string, string>): void {
  if (Object.keys(assignments).length === 0) return;
  for (const comp of components) {
    const roots = comp.kind === "component" ? [comp.root] : comp.variants.map((v) => v.root);
    for (const root of roots) walk(root);
  }

  function walk(node: Node): void {
    if (node.type === "instance") {
      const variantId = assignments[node.id];
      if (variantId && node.componentRef.kind === "variant") {
        node.componentRef = { kind: "variant", componentSetId: node.componentRef.componentSetId, variantId };
      }
      return;
    }
    if (node.type === "frame" || node.type === "group") {
      for (const child of node.children) walk(child);
    }
  }
}
