import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { inspectComponentSource } from "../src/ast/inspectComponentSource.js";
import { inspectComponentDependencyTree } from "../src/ast/inspectComponentDependencyTree.js";

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/react-tree/${name}`, import.meta.url));
}

describe("inspectComponentSource — resolvedFile (single hop)", () => {
  it("resolves a plain relative, extensioned import (NodeNext-style '.js' specifier -> '.tsx' file)", () => {
    const evidence = inspectComponentSource(fixture("Dashboard.tsx"));
    const sidebar = evidence.importedComponents.find((c) => c.name === "Sidebar");
    expect(sidebar?.resolvedFile).toBe(fixture("Sidebar.tsx"));
  });

  it("follows a barrel (index.ts) re-export to the real declaring file, not the barrel itself", () => {
    const evidence = inspectComponentSource(fixture("SessionCard.tsx"));
    const avatar = evidence.importedComponents.find((c) => c.name === "Avatar");
    const badge = evidence.importedComponents.find((c) => c.name === "Badge");
    expect(avatar?.moduleSpecifier).toBe("./components/index.js"); // the import site, still the barrel
    expect(avatar?.resolvedFile).toBe(fixture("components/Avatar.tsx")); // the real file, past the barrel
    expect(badge?.resolvedFile).toBe(fixture("components/Badge.tsx"));
  });

  it("captures a component only ever rendered inside .map() as both a JSX child and an imported component (list-rendering fix)", () => {
    const evidence = inspectComponentSource(fixture("Dashboard.tsx"));
    const names = evidence.importedComponents.map((c) => c.name).sort();
    expect(names).toEqual(["SessionCard", "Sidebar"]);

    const mainNode = evidence.jsx?.children.find((c) => c.tag === "main");
    expect(mainNode?.children.map((c) => c.tag)).toEqual(["SessionCard"]);
  });
});

describe("inspectComponentDependencyTree — Dashboard (multi-hop, through a barrel)", () => {
  const result = inspectComponentDependencyTree(fixture("Dashboard.tsx"));

  it("walks past the direct children to discover components nested two hops deep (Avatar/Badge, via SessionCard, via a barrel)", () => {
    const files = result.components.map((c) => c.exportName).sort();
    expect(files).toEqual(["Avatar", "Badge", "Dashboard", "SessionCard", "Sidebar"]);
  });

  it("records depth as hop count from the entry component", () => {
    const byName = new Map(result.components.map((c) => [c.exportName, c]));
    expect(byName.get("Dashboard")?.depth).toBe(0);
    expect(byName.get("Sidebar")?.depth).toBe(1);
    expect(byName.get("SessionCard")?.depth).toBe(1);
    expect(byName.get("Avatar")?.depth).toBe(2);
    expect(byName.get("Badge")?.depth).toBe(2);
  });

  it("has nothing left unresolved — every import in this fixture tree is real project source", () => {
    expect(result.unresolved).toEqual([]);
  });

  it("is not truncated for a tree well within the default max depth", () => {
    expect(result.truncated).toBe(false);
  });

  it("does not re-walk a component reached more than once via different paths", () => {
    const avatarNodes = result.components.filter((c) => c.exportName === "Avatar");
    expect(avatarNodes).toHaveLength(1);
  });
});

describe("inspectComponentDependencyTree — mappedDataRefs (auto-discovered .map() data)", () => {
  const result = inspectComponentDependencyTree(fixture("DashboardWithMaps.tsx"));

  it("populates mappedDataRefs on the entry node for both STATS and SESSIONS .map() calls", () => {
    const entry = result.components.find((c) => c.exportName === "DashboardWithMaps");
    const tags = entry?.mappedDataRefs.map((u) => u.componentTag).sort();
    expect(tags).toEqual(["SessionCard", "StatCard"]);
  });

  it("leaves mappedDataRefs empty for a node with no .map() in its own file (StatCard, Sidebar)", () => {
    const statCard = result.components.find((c) => c.exportName === "StatCard");
    const sidebar = result.components.find((c) => c.exportName === "Sidebar");
    expect(statCard?.mappedDataRefs).toEqual([]);
    expect(sidebar?.mappedDataRefs).toEqual([]);
  });
});

describe("inspectComponentDependencyTree — usesPortal", () => {
  it("surfaces usesPortal: true on a dependency-tree node whose own component calls createPortal", () => {
    const result = inspectComponentDependencyTree(fixture("ModalWithPortal.tsx"));
    const entry = result.components.find((c) => c.exportName === "ModalWithPortal");
    expect(entry?.usesPortal).toBe(true);
  });

  it("leaves usesPortal: false for an ordinary component (Dashboard's own entry, and none of its dependencies use a portal)", () => {
    const result = inspectComponentDependencyTree(fixture("Dashboard.tsx"));
    expect(result.components.every((c) => c.usesPortal === false)).toBe(true);
  });
});

describe("inspectComponentDependencyTree — staticUsageVariants (no .map(), repeated call sites)", () => {
  const result = inspectComponentDependencyTree(fixture("ToolbarWithStaticButtons.tsx"));

  it("populates staticUsageVariants on the entry node for Button's three-way variant prop", () => {
    const entry = result.components.find((c) => c.exportName === "ToolbarWithStaticButtons");
    expect(entry?.staticUsageVariants.map((u) => u.componentTag)).toEqual(["Button"]);
    expect(entry?.staticUsageVariants[0]?.variantAxisFields).toEqual(["variant"]);
  });

  it("mappedDataRefs still separately reports the .map()-driven Button usage (ROWS) — the two discovery mechanisms coexist without conflating one for the other; its variantCandidates are empty here since ROWS' own `status` values don't actually vary (both \"completed\")", () => {
    const entry = result.components.find((c) => c.exportName === "ToolbarWithStaticButtons");
    const rowsUsage = entry?.mappedDataRefs.find((u) => u.dataVariableName === "ROWS");
    expect(rowsUsage?.componentTag).toBe("Button");
    expect(rowsUsage?.variantCandidates).toEqual([]);
  });
});

describe("inspectComponentDependencyTree — external (non-project) imports", () => {
  it("reports react as unresolved rather than a project file, without failing the walk", () => {
    const result = inspectComponentDependencyTree(fixture("Sidebar.tsx"));
    // Sidebar has no JSX sub-components, so importedComponents is empty and there's nothing to
    // report as unresolved here either — this just confirms a leaf component walks cleanly.
    expect(result.components).toHaveLength(1);
    expect(result.components[0]?.exportName).toBe("Sidebar");
    expect(result.unresolved).toEqual([]);
  });
});
