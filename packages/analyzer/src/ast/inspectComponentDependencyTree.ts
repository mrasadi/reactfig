import { Project } from "ts-morph";
import type { ComponentSourceEvidence, ImportedComponentRef } from "../evidence/types.js";
import { inspectComponentSourceFromFile, RESOLUTION_COMPILER_OPTIONS } from "./inspectComponentSource.js";
import { extractMappedDataRefs, type MappedComponentUsage } from "./extractMappedDataRefs.js";
import { extractStaticUsageVariants, type StaticComponentUsage } from "./extractStaticUsageVariants.js";

export interface InspectDependencyTreeOptions {
  /** Which exported component to start from, in the entry file. If omitted, the first capitalized named export is used — same default as inspectComponentSource. */
  exportName?: string;
  /**
   * How many import hops to follow from the entry component. Default 8 —
   * generous for any real component tree, but bounded so a resolution bug
   * (or a genuinely unusual project) can't turn into an unbounded walk.
   * Depth 0 would just be the entry component itself; depth 1 is direct
   * children only (equivalent to a single inspect_component_source call).
   */
  maxDepth?: number;
}

/** One component in the tree, plus how it was reached. */
export interface DependencyTreeNode {
  file: string;
  exportName: string;
  /** Hop count from the entry component (entry itself is 0). */
  depth: number;
  /** This component's own direct sub-components, same shape inspect_component_source returns. */
  importedComponents: ImportedComponentRef[];
  /**
   * `.map()` list-rendering patterns found in this component's file, and the
   * const array each one iterates over — e.g. `STATS.map((stat) => <StatCard
   * {...stat} />)`. This is what lets a caller auto-discover per-instance
   * data (three different StatCards, not the same capture repeated three
   * times) instead of requiring it to be supplied by hand. Empty when the
   * file has no `.map()` over a component.
   */
  mappedDataRefs: MappedComponentUsage[];
  /**
   * Variant-capture candidates for a component with NO `.map()` array
   * behind it — just the same tag written out at multiple JSX call sites
   * in this file with different literal prop values (e.g. `<Button
   * variant="primary">`/`<Button variant="secondary">`). See
   * `extractStaticUsageVariants`'s doc comment for why this is a separate
   * mechanism from `mappedDataRefs`, not a special case of it. Empty when
   * the file has no component used this way.
   */
  staticUsageVariants: StaticComponentUsage[];
  /**
   * Whether this component's own body calls `createPortal` — see
   * `detectPortalUsage.ts`'s doc comment. A caller building a capture
   * plan for a component (or its dependencies) should treat `true` here
   * as a signal that this component's own evidence may be missing
   * content that renders outside its DOM subtree (a modal, tooltip, or
   * dropdown menu), not as a capture failure to work around.
   */
  usesPortal: boolean;
}

export interface InspectDependencyTreeResult {
  /** Every component reached, entry included, in the order first visited (breadth-first). Deduplicated by file — a component imported from two places in the tree is only walked, and appears, once. */
  components: DependencyTreeNode[];
  /**
   * Imported JSX tags that were never resolved to a project source file —
   * either a real external package (icon libraries, UI kits) or a project
   * import ts-morph's resolver couldn't settle (e.g. a path alias with no
   * tsconfig loaded). Deduplicated by name + moduleSpecifier. This is
   * exactly the information a caller needs to know which `external:<Name>`
   * refs in a generated Design IR can *never* be resolved by discovering
   * more checkpoints, because there is no further project source to
   * generate one from — as opposed to ones simply not generated yet.
   */
  unresolved: ImportedComponentRef[];
  /** True if `maxDepth` was hit while there was still more graph to walk — i.e. this result may be incomplete. */
  truncated: boolean;
}

/**
 * Walks the full, nested component-composition tree starting from one file,
 * rather than the single import hop `inspect_component_source` reports.
 *
 * `inspect_component_source` on its own only tells you a component's direct
 * children — e.g. inspecting Dashboard.tsx reports Sidebar, Header,
 * StatCard, and SessionCard, but says nothing about SessionCard's own
 * Avatar/Badge/Button children. Discovering the *full* tree previously
 * meant a caller manually inspecting every child's file in turn, one level
 * at a time, and remembering to keep going wherever a child itself had
 * children — easy to stop a level too early on a real component tree. This
 * does that walk in one call.
 */
export function inspectComponentDependencyTree(
  entryFilePath: string,
  options: InspectDependencyTreeOptions = {}
): InspectDependencyTreeResult {
  const maxDepth = options.maxDepth ?? 8;
  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: RESOLUTION_COMPILER_OPTIONS,
  });

  const components: DependencyTreeNode[] = [];
  const unresolvedByKey = new Map<string, ImportedComponentRef>();
  const visitedFiles = new Set<string>();
  const queuedFiles = new Set<string>([entryFilePath]);
  let truncated = false;

  type QueueItem = { file: string; exportName: string | undefined; depth: number };
  const queue: QueueItem[] = [{ file: entryFilePath, exportName: options.exportName, depth: 0 }];

  while (queue.length > 0) {
    const item = queue.shift()!;

    let evidence: ComponentSourceEvidence;
    let mappedDataRefs: MappedComponentUsage[] = [];
    let staticUsageVariants: StaticComponentUsage[] = [];
    try {
      const sourceFile = project.addSourceFileAtPathIfExists(item.file) ?? project.addSourceFileAtPath(item.file);
      evidence = inspectComponentSourceFromFile(sourceFile, { exportName: item.exportName });
      mappedDataRefs = extractMappedDataRefs(sourceFile);
      staticUsageVariants = extractStaticUsageVariants(sourceFile);
    } catch {
      // A resolved import that doesn't actually contain a recognizable
      // function component (e.g. it resolves to a constants file, a type-only
      // export, or an unsupported component form) — record what we know from
      // the link that got us here and stop walking that branch, rather than
      // failing the whole tree over one unwalkable node.
      continue;
    }

    if (visitedFiles.has(evidence.file)) continue;
    visitedFiles.add(evidence.file);

    components.push({
      file: evidence.file,
      exportName: evidence.exportName,
      depth: item.depth,
      importedComponents: evidence.importedComponents,
      mappedDataRefs,
      staticUsageVariants,
      usesPortal: evidence.usesPortal,
    });

    for (const ref of evidence.importedComponents) {
      if (!ref.resolvedFile) {
        unresolvedByKey.set(`${ref.name}::${ref.moduleSpecifier}`, ref);
        continue;
      }
      if (visitedFiles.has(ref.resolvedFile) || queuedFiles.has(ref.resolvedFile)) continue; // already walked, or already on the queue, via another path through the tree
      if (item.depth + 1 > maxDepth) {
        truncated = true;
        continue;
      }
      queuedFiles.add(ref.resolvedFile);
      queue.push({ file: ref.resolvedFile, exportName: undefined, depth: item.depth + 1 });
    }
  }

  return {
    components,
    unresolved: Array.from(unresolvedByKey.values()),
    truncated,
  };
}
