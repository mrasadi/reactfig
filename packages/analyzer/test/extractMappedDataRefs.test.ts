import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { Project, ModuleResolutionKind, ts } from "ts-morph";
import { extractMappedDataRefs, type MappedComponentUsage } from "../src/ast/extractMappedDataRefs.js";

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/react-tree/${name}`, import.meta.url));
}

function loadSourceFile(path: string) {
  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { moduleResolution: ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext },
  });
  return project.addSourceFileAtPath(path);
}

function usageFor(usages: MappedComponentUsage[], componentTag: string): MappedComponentUsage {
  const usage = usages.find((u) => u.componentTag === componentTag);
  if (!usage) throw new Error(`no usage found for ${componentTag}`);
  return usage;
}

describe("extractMappedDataRefs — DashboardWithMaps (STATS + SESSIONS)", () => {
  const sourceFile = loadSourceFile(fixture("DashboardWithMaps.tsx"));
  const usages = extractMappedDataRefs(sourceFile);

  it("finds one usage per .map() call", () => {
    expect(usages).toHaveLength(2);
    expect(usages.map((u) => u.componentTag).sort()).toEqual(["SessionCard", "StatCard"]);
  });

  it("extracts STATS data array values exactly, all 3 items", () => {
    const stats = usageFor(usages, "StatCard");
    const statsSource = stats.dataSources.find((d) => d.variableName === "STATS");
    expect(statsSource?.items).toEqual([
      { label: "Sessions this week", value: "12", tone: "neutral" },
      { label: "Avg. speaking score", value: "6.8", tone: "success" },
      { label: "Missed sessions", value: "1", tone: "warning" },
    ]);
  });

  it("reports componentTag StatCard with parentFile pointing to DashboardWithMaps.tsx", () => {
    const stats = usageFor(usages, "StatCard");
    expect(stats.componentTag).toBe("StatCard");
    expect(stats.parentFile).toBe(fixture("DashboardWithMaps.tsx"));
  });

  it("extracts the callback param name 'stat'", () => {
    expect(usageFor(usages, "StatCard").mapCallbackParamName).toBe("stat");
  });

  it("detects spreadAttributes for the {...stat} pattern", () => {
    expect(usageFor(usages, "StatCard").spreadAttributes).toBe(true);
  });

  it("marks mapped item fields sourced from hardcoded literal values as valueKind 'literal'", () => {
    const stats = usageFor(usages, "StatCard");
    const value = stats.mappedKeys.find((k) => k.keyInItem === "value");
    const label = stats.mappedKeys.find((k) => k.keyInItem === "label");
    expect(value?.field.valueKind).toBe("literal");
    expect(label?.field.valueKind).toBe("literal");
  });

  it("includes every STATS field via the {...stat} spread (label, value, tone) — plus 'key', which separately reads stat.label", () => {
    const stats = usageFor(usages, "StatCard");
    const uniqueKeysInItem = [...new Set(stats.mappedKeys.map((k) => k.keyInItem))].sort();
    expect(uniqueKeysInItem).toEqual(["label", "tone", "value"]);
    expect(stats.mappedKeys.map((k) => k.field.propertyName).sort()).toEqual(["key", "label", "tone", "value"]);
  });

  it("extracts SessionCard usage similarly — data, tag, param name, spread, fields", () => {
    const sessions = usageFor(usages, "SessionCard");
    const sessionsSource = sessions.dataSources.find((d) => d.variableName === "SESSIONS");

    expect(sessionsSource?.items).toEqual([
      { learnerName: "Amir", avatarSrc: "/a.png", status: "completed" },
      { learnerName: "Sara", avatarSrc: "/s.png", status: "scheduled" },
    ]);
    expect(sessions.parentFile).toBe(fixture("DashboardWithMaps.tsx"));
    expect(sessions.dataVariableName).toBe("SESSIONS");
    expect(sessions.mapCallbackParamName).toBe("session");
    expect(sessions.spreadAttributes).toBe(true);
    const uniqueKeysInItem = [...new Set(sessions.mappedKeys.map((k) => k.keyInItem))].sort();
    expect(uniqueKeysInItem).toEqual(["avatarSrc", "learnerName", "status"]);
  });

  it("carries both const arrays as dataSources on every usage in the file", () => {
    const stats = usageFor(usages, "StatCard");
    expect(stats.dataSources.map((d) => d.variableName).sort()).toEqual(["SESSIONS", "STATS"]);
  });
});

describe("extractMappedDataRefs — no .map() in the file", () => {
  it("returns an empty array for a component without .map() (Sidebar)", () => {
    const sourceFile = loadSourceFile(fixture("Sidebar.tsx"));
    expect(extractMappedDataRefs(sourceFile)).toEqual([]);
  });
});
