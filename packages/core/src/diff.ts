import type { AssetRef, ComponentDef, ComponentSet, ComponentVariant, DesignDocument, Node, Page } from "./types.js";

/**
 * design-ir/v1 semantic diff.
 *
 * Deliberately NOT a generic JSON diff (see docs/adr/0017-checkpoint-
 * versioning-and-diff.md): a raw structural diff of two Design IR
 * documents is dominated by noise that carries no design meaning —
 * `meta.generatedAt` differs on every single generation, and comparing
 * `children` arrays by index reports "node 3 removed / node 3 added"
 * for a node that simply changed position, rather than "nothing
 * meaningful changed here". This module matches nodes/components/
 * variants/pages/assets by their stable `id` field (never by array
 * index) before comparing their properties, and only ever reports
 * fields this format actually assigns design meaning to.
 *
 * Categories and matching intentionally mirror `merge.ts`'s existing
 * id-based approach (component/variant ids are matched directly; nodes
 * are matched by `id` within a tree) rather than introducing a second,
 * different identity strategy for the same document shape.
 */

export type DiffCategory =
  | "structure"
  | "layout"
  | "bounds"
  | "typography"
  | "fills"
  | "strokes"
  | "effects"
  | "assets"
  | "instances"
  | "variants"
  | "pages"
  | "metadata";

export type DiffChangeType = "added" | "removed" | "changed";

/**
 * `structure`/`instances`/`variants`/`pages` changes (additions,
 * removals, a node's type changing, a componentRef repointing) are
 * "major" — they change what exists or what an instance renders as.
 * Everything else (a bounds/typography/fill/stroke/effect/asset/
 * metadata value changing) is "minor" — the same things still exist,
 * something about how they look moved. This is a category-based rule,
 * not a numeric threshold on e.g. how many pixels a bounds value moved
 * by — simple, deterministic, and avoids inventing an arbitrary
 * "how much of a width change counts as major" cutoff (ADR 0017 §
 * "keep it simple").
 */
const MAJOR_CATEGORIES: ReadonlySet<DiffCategory> = new Set(["structure", "instances", "variants", "pages"]);

export interface DiffEntry {
  category: DiffCategory;
  /** A breadcrumb path through stable ids/keys, e.g. `components/comp_button/root/children/node_label/typography/fontWeight` — NOT a JSON Pointer with array indices, since indices are exactly what id-based matching avoids depending on. */
  path: string;
  before?: unknown;
  after?: unknown;
  change: DiffChangeType;
  severity: "major" | "minor";
}

export interface DesignIrDiffResult {
  identical: boolean;
  entries: DiffEntry[];
  /** Entry count per category, only for categories with at least one entry — a quick "what kind of changes are these" summary before reading every entry. */
  summary: Partial<Record<DiffCategory, number>>;
}

function push(
  entries: DiffEntry[],
  category: DiffCategory,
  path: string,
  change: DiffChangeType,
  before: unknown,
  after: unknown,
  severityOverride?: "major" | "minor"
): void {
  entries.push({
    category,
    path,
    before,
    after,
    change,
    severity: severityOverride ?? (MAJOR_CATEGORIES.has(category) ? "major" : "minor"),
  });
}

/** Shallow value equality sufficient for the leaf field types this module compares (numbers, strings, booleans, plain color/token objects, arrays of stops). Deliberately not a generic deep-equal utility — every call site here compares one already-typed field, never an arbitrary unknown. */
function fieldsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffField(entries: DiffEntry[], category: DiffCategory, path: string, before: unknown, after: unknown): void {
  if (before === undefined && after === undefined) return;
  if (!fieldsEqual(before, after)) push(entries, category, path, "changed", before, after);
}

function diffBounds(entries: DiffEntry[], path: string, before: Node["bounds"] | undefined, after: Node["bounds"] | undefined): void {
  if (!before || !after) {
    diffField(entries, "bounds", path, before, after);
    return;
  }
  for (const axis of ["x", "y", "width", "height"] as const) {
    if (before[axis] !== after[axis]) push(entries, "bounds", `${path}/${axis}`, "changed", before[axis], after[axis]);
  }
}

function diffTypography(entries: DiffEntry[], path: string, before: import("./types.js").Typography, after: import("./types.js").Typography): void {
  for (const key of ["fontFamily", "fontWeight", "fontSize", "lineHeight", "letterSpacing", "textAlign", "italic"] as const) {
    diffField(entries, "typography", `${path}/${key}`, before[key], after[key]);
  }
}

/** Matches a list of id-bearing items by id (never index), returning matched pairs plus before-only/after-only leftovers, in the same one-pass shape every id-matched comparison in this module needs. */
function matchById<T extends { id: string }>(before: T[], after: T[]): { matched: [T, T][]; removed: T[]; added: T[] } {
  const afterById = new Map(after.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const matched: [T, T][] = [];
  const removed: T[] = [];
  for (const b of before) {
    const a = afterById.get(b.id);
    if (a) {
      matched.push([b, a]);
      seen.add(b.id);
    } else {
      removed.push(b);
    }
  }
  const added = after.filter((a) => !seen.has(a.id));
  return { matched, removed, added };
}

/**
 * Reports a reorder as a single minor structure entry when a parent's
 * children have the exact same id set before and after but in a
 * different sequence — distinct from an add/remove, which matchById
 * already reports separately. Skipped entirely when the id sets differ,
 * since add/remove entries already cover that case.
 */
function diffChildOrder(entries: DiffEntry[], path: string, before: Node[], after: Node[]): void {
  const beforeIds = before.map((n) => n.id);
  const afterIds = after.map((n) => n.id);
  if (beforeIds.length !== afterIds.length) return;
  const beforeSet = new Set(beforeIds);
  if (afterIds.some((id) => !beforeSet.has(id))) return;
  if (beforeIds.every((id, i) => id === afterIds[i])) return;
  // Same id set, different sequence: worth surfacing (a reorder can still
  // be a real visual regression) but explicitly minor — it's categorized
  // as "structure" for grouping purposes only, not because reordering
  // ranks with an actual addition/removal.
  push(entries, "structure", `${path}/children (order)`, "changed", beforeIds, afterIds, "minor");
}

function diffNode(entries: DiffEntry[], path: string, before: Node, after: Node): void {
  if (before.type !== after.type) {
    push(entries, "structure", `${path}/type`, "changed", before.type, after.type);
    // A type change means every type-specific field below is meaningless
    // to compare (a Frame's `layout` vs a Text's `typography` aren't the
    // same axis) — the type change itself is the whole story here.
    return;
  }

  diffField(entries, "layout", `${path}/name`, before.name, after.name);
  diffField(entries, "layout", `${path}/visible`, before.visible ?? true, after.visible ?? true);
  diffField(entries, "layout", `${path}/opacity`, before.opacity ?? 1, after.opacity ?? 1);
  diffBounds(entries, `${path}/bounds`, before.bounds, after.bounds);

  switch (before.type) {
    case "frame": {
      const a = after as Extract<Node, { type: "frame" }>;
      diffField(entries, "layout", `${path}/layout`, before.layout, a.layout);
      diffField(entries, "layout", `${path}/cornerRadius`, before.cornerRadius, a.cornerRadius);
      diffField(entries, "layout", `${path}/clipsContent`, before.clipsContent, a.clipsContent);
      diffField(entries, "fills", `${path}/fills`, before.fills, a.fills);
      diffField(entries, "strokes", `${path}/strokes`, before.strokes, a.strokes);
      diffField(entries, "effects", `${path}/effects`, before.effects, a.effects);
      diffChildren(entries, path, before.children, a.children);
      diffChildOrder(entries, path, before.children, a.children);
      break;
    }
    case "group": {
      const a = after as Extract<Node, { type: "group" }>;
      diffChildren(entries, path, before.children, a.children);
      diffChildOrder(entries, path, before.children, a.children);
      break;
    }
    case "text": {
      const a = after as Extract<Node, { type: "text" }>;
      diffField(entries, "structure", `${path}/characters`, before.characters, a.characters);
      diffTypography(entries, `${path}/typography`, before.typography, a.typography);
      diffField(entries, "fills", `${path}/fills`, before.fills, a.fills);
      break;
    }
    case "shape": {
      const a = after as Extract<Node, { type: "shape" }>;
      diffField(entries, "layout", `${path}/shape`, before.shape, a.shape);
      diffField(entries, "layout", `${path}/cornerRadius`, before.cornerRadius, a.cornerRadius);
      diffField(entries, "fills", `${path}/fills`, before.fills, a.fills);
      diffField(entries, "strokes", `${path}/strokes`, before.strokes, a.strokes);
      diffField(entries, "effects", `${path}/effects`, before.effects, a.effects);
      break;
    }
    case "image": {
      const a = after as Extract<Node, { type: "image" }>;
      diffField(entries, "assets", `${path}/assetId`, before.assetId, a.assetId);
      diffField(entries, "layout", `${path}/cornerRadius`, before.cornerRadius, a.cornerRadius);
      diffField(entries, "effects", `${path}/effects`, before.effects, a.effects);
      break;
    }
    case "instance": {
      const a = after as Extract<Node, { type: "instance" }>;
      diffField(entries, "instances", `${path}/componentRef`, before.componentRef, a.componentRef);
      diffField(entries, "instances", `${path}/propertyOverrides`, before.propertyOverrides, a.propertyOverrides);
      diffField(entries, "instances", `${path}/overrides`, before.overrides, a.overrides);
      diffField(entries, "layout", `${path}/layout`, before.layout, a.layout);
      break;
    }
  }
}

function diffChildren(entries: DiffEntry[], path: string, before: Node[], after: Node[]): void {
  const { matched, removed, added } = matchById(before, after);
  for (const node of removed) push(entries, "structure", `${path}/children/${node.id}`, "removed", summarizeNode(node), undefined);
  for (const node of added) push(entries, "structure", `${path}/children/${node.id}`, "added", undefined, summarizeNode(node));
  for (const [b, a] of matched) diffNode(entries, `${path}/children/${b.id}`, b, a);
}

function summarizeNode(node: Node): { id: string; type: Node["type"]; name: string } {
  return { id: node.id, type: node.type, name: node.name };
}

function diffComponentRoot(entries: DiffEntry[], path: string, before: ComponentDef | ComponentVariant, after: ComponentDef | ComponentVariant): void {
  diffNode(entries, `${path}/root`, before.root, after.root);
}

function diffComponent(entries: DiffEntry[], path: string, before: ComponentDef | ComponentSet, after: ComponentDef | ComponentSet): void {
  diffField(entries, "structure", `${path}/name`, before.name, after.name);
  if (before.kind !== after.kind) {
    push(entries, "structure", `${path}/kind`, "changed", before.kind, after.kind);
    return;
  }
  diffField(entries, "instances", `${path}/properties`, before.properties, after.properties);

  if (before.kind === "component") {
    diffComponentRoot(entries, path, before, after as ComponentDef);
    return;
  }

  const a = after as ComponentSet;
  diffField(entries, "variants", `${path}/variantProperties`, before.variantProperties, a.variantProperties);
  const { matched, removed, added } = matchById(before.variants, a.variants);
  for (const v of removed) push(entries, "variants", `${path}/variants/${v.id}`, "removed", v.propertyValues, undefined);
  for (const v of added) push(entries, "variants", `${path}/variants/${v.id}`, "added", undefined, v.propertyValues);
  for (const [bv, av] of matched) {
    diffField(entries, "variants", `${path}/variants/${bv.id}/propertyValues`, bv.propertyValues, av.propertyValues);
    diffComponentRoot(entries, `${path}/variants/${bv.id}`, bv, av);
  }
}

function diffAssets(entries: DiffEntry[], before: AssetRef[], after: AssetRef[]): void {
  const { matched, removed, added } = matchById(before, after);
  for (const asset of removed) push(entries, "assets", `assets/${asset.id}`, "removed", asset, undefined);
  for (const asset of added) push(entries, "assets", `assets/${asset.id}`, "added", undefined, asset);
  for (const [b, a] of matched) {
    for (const key of ["path", "mimeType", "width", "height"] as const) {
      diffField(entries, "assets", `assets/${b.id}/${key}`, b[key], a[key]);
    }
  }
}

function diffPage(entries: DiffEntry[], path: string, before: Page, after: Page): void {
  diffField(entries, "pages", `${path}/name`, before.name, after.name);
  diffChildren(entries, path, before.children, after.children);
  diffChildOrder(entries, path, before.children, after.children);
}

function diffPages(entries: DiffEntry[], before: Page[], after: Page[]): void {
  const { matched, removed, added } = matchById(before, after);
  for (const page of removed) push(entries, "pages", `pages/${page.id}`, "removed", page.name, undefined);
  for (const page of added) push(entries, "pages", `pages/${page.id}`, "added", undefined, page.name);
  for (const [b, a] of matched) diffPage(entries, `pages/${b.id}`, b, a);
}

/**
 * Compares two design-ir/v1 documents and returns every semantically
 * meaningful difference, id-matched (never index-matched) at every
 * level: pages, components/variants, and nodes within each component's
 * tree. `meta.generatedAt` is intentionally never compared — it differs
 * on every generation and carries no design meaning (ADR 0017).
 * `document.$schema`/`version`/`id` are also excluded: `id` is a
 * document identity, not a design property, and a version/schema
 * mismatch is a validation concern the caller's validator already
 * surfaces, not something this diff should re-report as a "change".
 */
export function diffDesignDocuments(before: DesignDocument, after: DesignDocument): DesignIrDiffResult {
  const entries: DiffEntry[] = [];

  diffField(entries, "metadata", "name", before.name, after.name);
  diffField(entries, "metadata", "meta/generator", before.meta.generator, after.meta.generator);
  diffField(entries, "metadata", "meta/sourceProject", before.meta.sourceProject, after.meta.sourceProject);

  diffPages(entries, before.pages, after.pages);

  const { matched, removed, added } = matchById(before.components, after.components);
  for (const comp of removed) push(entries, "structure", `components/${comp.id}`, "removed", comp.name, undefined);
  for (const comp of added) push(entries, "structure", `components/${comp.id}`, "added", undefined, comp.name);
  for (const [b, a] of matched) diffComponent(entries, `components/${b.id}`, b, a);

  diffAssets(entries, before.assets, after.assets);

  // Deterministic regardless of internal traversal order: group by
  // category, then sort by path within each category, then by change
  // type so added/changed/removed for the same path are stable too.
  entries.sort((x, y) => x.category.localeCompare(y.category) || x.path.localeCompare(y.path) || x.change.localeCompare(y.change));

  const summary: Partial<Record<DiffCategory, number>> = {};
  for (const entry of entries) summary[entry.category] = (summary[entry.category] ?? 0) + 1;

  return { identical: entries.length === 0, entries, summary };
}

/**
 * Renders a `DesignIrDiffResult` as the human-readable report shape
 * from ADR 0017 — one section per category (uppercased), one line per
 * changed path plus its before → after values, and a leading `+`/`-`
 * for added/removed entries. Structured `entries`/`summary` remain the
 * form a caller should consume programmatically; this is only for
 * display (e.g. the diff_design_ir MCP tool's `report` field, or a
 * human paging through terminal output).
 */
export function formatDesignIrDiff(result: DesignIrDiffResult, title = "Design IR diff"): string {
  if (result.identical) return `${title}\n${"─".repeat(title.length)}\n(no semantic differences)`;

  const byCategory = new Map<DiffCategory, DiffEntry[]>();
  for (const entry of result.entries) {
    if (!byCategory.has(entry.category)) byCategory.set(entry.category, []);
    byCategory.get(entry.category)!.push(entry);
  }

  const lines: string[] = [title, "─".repeat(Math.max(title.length, 24))];
  for (const [category, categoryEntries] of byCategory) {
    lines.push(category.toUpperCase());
    for (const entry of categoryEntries) {
      if (entry.change === "added") {
        lines.push(`  + ${entry.path}`);
      } else if (entry.change === "removed") {
        lines.push(`  - ${entry.path}`);
      } else {
        lines.push(`  ${entry.path}`);
        lines.push(`    ${formatValue(entry.before)} \u2192 ${formatValue(entry.after)}`);
      }
    }
  }
  return lines.join("\n");
}

function formatValue(value: unknown): string {
  if (value === undefined) return "(none)";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
