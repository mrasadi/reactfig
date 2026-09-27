import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { inspectComponentDependencyTreeTool } from "../../src/tools/inspectComponentDependencyTree.js";

const sampleAppRoot = fileURLToPath(new URL("../../../../examples/sample-react-app", import.meta.url));

describe("inspectComponentDependencyTreeTool — real sample app (Dashboard)", () => {
  it("discovers components nested two hops deep (Avatar/Badge/Button, via SessionCard), not just Dashboard's direct children", async () => {
    const result = await inspectComponentDependencyTreeTool(
      { sourceFile: "src/screens/Dashboard.tsx" },
      { projectRoot: sampleAppRoot }
    );

    const names = result.components.map((c) => c.exportName).sort();
    expect(names).toEqual(["Avatar", "Badge", "Button", "Dashboard", "Header", "SessionCard", "Sidebar", "StatCard"]);
  });

  it("resolves everything to real project source in this app — nothing genuinely unresolved", async () => {
    const result = await inspectComponentDependencyTreeTool(
      { sourceFile: "src/screens/Dashboard.tsx" },
      { projectRoot: sampleAppRoot }
    );
    expect(result.unresolved).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("dedupes Avatar, which is reached via both Header and SessionCard", async () => {
    const result = await inspectComponentDependencyTreeTool(
      { sourceFile: "src/screens/Dashboard.tsx" },
      { projectRoot: sampleAppRoot }
    );
    expect(result.components.filter((c) => c.exportName === "Avatar")).toHaveLength(1);
  });

  it("populates mappedDataRefs for Dashboard's own .map() calls over STATS and SESSIONS", async () => {
    const result = await inspectComponentDependencyTreeTool(
      { sourceFile: "src/screens/Dashboard.tsx" },
      { projectRoot: sampleAppRoot }
    );

    const dashboard = result.components.find((c) => c.exportName === "Dashboard");
    expect(dashboard?.mappedDataRefs).toBeDefined();

    const tags = dashboard?.mappedDataRefs.map((u) => u.componentTag).sort();
    expect(tags).toEqual(["SessionCard", "StatCard"]);

    const statCardUsage = dashboard?.mappedDataRefs.find((u) => u.componentTag === "StatCard");
    expect(statCardUsage?.dataVariableName).toBe("STATS");
    expect(statCardUsage?.spreadAttributes).toBe(true);
    expect(statCardUsage?.dataSources.find((d) => d.variableName === "STATS")?.items).toHaveLength(3);

    const sessionCardUsage = dashboard?.mappedDataRefs.find((u) => u.componentTag === "SessionCard");
    expect(sessionCardUsage?.dataVariableName).toBe("SESSIONS");
    expect(sessionCardUsage?.dataSources.find((d) => d.variableName === "SESSIONS")?.items).toHaveLength(3);
  });

  it("leaves mappedDataRefs empty for nested components with no .map() of their own (e.g. Avatar)", async () => {
    const result = await inspectComponentDependencyTreeTool(
      { sourceFile: "src/screens/Dashboard.tsx" },
      { projectRoot: sampleAppRoot }
    );
    const avatar = result.components.find((c) => c.exportName === "Avatar");
    expect(avatar?.mappedDataRefs).toEqual([]);
  });

  it("respects maxDepth, truncating rather than walking past it", async () => {
    const result = await inspectComponentDependencyTreeTool(
      { sourceFile: "src/screens/Dashboard.tsx", maxDepth: 1 },
      { projectRoot: sampleAppRoot }
    );
    // depth 1 = Dashboard's direct children only; Avatar/Badge/Button (depth 2) are cut off.
    const names = result.components.map((c) => c.exportName).sort();
    expect(names).toEqual(["Dashboard", "Header", "SessionCard", "Sidebar", "StatCard"]);
    expect(result.truncated).toBe(true);
  });
});
