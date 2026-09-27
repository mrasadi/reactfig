import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { Project, ModuleResolutionKind, ts } from "ts-morph";
import { discoverVariantCaptures, type VariantCaptureCandidate } from "../src/ast/discoverVariantCaptures.js";
import { extractMappedDataRefs, type MappedComponentUsage } from "../src/ast/extractMappedDataRefs.js";

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/react-tree/${name}`, import.meta.url));
}

function sampleApp(relativePath: string): string {
  return fileURLToPath(new URL(`../../../examples/sample-react-app/${relativePath}`, import.meta.url));
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

function baseUsage(overrides: Partial<MappedComponentUsage> = {}): MappedComponentUsage {
  return {
    componentTag: "Widget",
    parentFile: "/fake/Widget.tsx",
    dataVariableName: "ITEMS",
    mapCallbackParamName: "item",
    spreadAttributes: true,
    mappedKeys: [],
    dataSources: [],
    variantAxisFields: [],
    variantCandidates: [],
    ...overrides,
  };
}

describe("discoverVariantCaptures — unit-level edge cases", () => {
  it("finds nothing when there's only 0 or 1 mapped item — nothing can vary", () => {
    const usage = baseUsage({
      mappedKeys: [{ field: { propertyName: "tone", valueKind: "literal" }, keyInItem: "tone" }],
      dataSources: [{ variableName: "ITEMS", arrayLiteralSource: "", items: [{ tone: "neutral" }] }],
    });
    expect(discoverVariantCaptures(usage)).toEqual({ axisFields: [], candidates: [] });
  });

  it("finds nothing when no data source matches dataVariableName", () => {
    const usage = baseUsage({ dataVariableName: "OTHER", dataSources: [{ variableName: "ITEMS", arrayLiteralSource: "", items: [{ tone: "a" }, { tone: "b" }] }] });
    expect(discoverVariantCaptures(usage)).toEqual({ axisFields: [], candidates: [] });
  });

  it("restricts axis candidates to fields actually passed as props (mappedKeys), ignoring data-only fields", () => {
    const usage = baseUsage({
      mappedKeys: [{ field: { propertyName: "tone", valueKind: "literal" }, keyInItem: "tone" }], // "internalId" not in mappedKeys
      dataSources: [
        {
          variableName: "ITEMS",
          arrayLiteralSource: "",
          items: [
            { tone: "neutral", internalId: "abc" },
            { tone: "success", internalId: "def" },
          ],
        },
      ],
    });
    const result = discoverVariantCaptures(usage);
    expect(result.axisFields).toEqual(["tone"]);
  });

  it("rejects a field with only one distinct value — not a variant axis", () => {
    const usage = baseUsage({
      mappedKeys: [{ field: { propertyName: "tone", valueKind: "literal" }, keyInItem: "tone" }],
      dataSources: [
        { variableName: "ITEMS", arrayLiteralSource: "", items: [{ tone: "neutral" }, { tone: "neutral" }, { tone: "neutral" }] },
      ],
    });
    expect(discoverVariantCaptures(usage)).toEqual({ axisFields: [], candidates: [] });
  });

  it("rejects free-text fields (spaces, punctuation) even with multiple distinct values — not enum-like", () => {
    const usage = baseUsage({
      mappedKeys: [{ field: { propertyName: "learnerName", valueKind: "literal" }, keyInItem: "learnerName" }],
      dataSources: [
        { variableName: "ITEMS", arrayLiteralSource: "", items: [{ learnerName: "Amir Hosseini" }, { learnerName: "Sara Ahmadi" }] },
      ],
    });
    expect(discoverVariantCaptures(usage)).toEqual({ axisFields: [], candidates: [] });
  });

  it("rejects a numeric field even with multiple distinct values", () => {
    const usage = baseUsage({
      mappedKeys: [{ field: { propertyName: "value", valueKind: "literal" }, keyInItem: "value" }],
      dataSources: [{ variableName: "ITEMS", arrayLiteralSource: "", items: [{ value: "12" }, { value: "6.8" }, { value: "1" }] }],
    });
    // "12"/"6.8"/"1" all start with a digit — the enum-token pattern requires a leading letter.
    expect(discoverVariantCaptures(usage)).toEqual({ axisFields: [], candidates: [] });
  });

  it("dedupes candidates by combination — the same visual state proposed only once, at its first occurrence", () => {
    const usage = baseUsage({
      mappedKeys: [{ field: { propertyName: "tone", valueKind: "literal" }, keyInItem: "tone" }],
      dataSources: [
        {
          variableName: "ITEMS",
          arrayLiteralSource: "",
          items: [{ tone: "neutral" }, { tone: "success" }, { tone: "neutral" }, { tone: "warning" }],
        },
      ],
    });
    const result = discoverVariantCaptures(usage);
    expect(result.axisFields).toEqual(["tone"]);
    expect(result.candidates).toEqual<VariantCaptureCandidate[]>([
      { instanceIndex: 0, propValues: { tone: "neutral" } },
      { instanceIndex: 1, propValues: { tone: "success" } },
      { instanceIndex: 3, propValues: { tone: "warning" } },
    ]);
  });

  it("combines two qualifying axis fields into one propValues object per candidate", () => {
    const usage = baseUsage({
      mappedKeys: [
        { field: { propertyName: "tone", valueKind: "literal" }, keyInItem: "tone" },
        { field: { propertyName: "size", valueKind: "literal" }, keyInItem: "size" },
      ],
      dataSources: [
        {
          variableName: "ITEMS",
          arrayLiteralSource: "",
          items: [
            { tone: "neutral", size: "small" },
            { tone: "success", size: "large" },
          ],
        },
      ],
    });
    const result = discoverVariantCaptures(usage);
    expect(result.axisFields.sort()).toEqual(["size", "tone"]);
    expect(result.candidates).toEqual<VariantCaptureCandidate[]>([
      { instanceIndex: 0, propValues: { size: "small", tone: "neutral" } },
      { instanceIndex: 1, propValues: { size: "large", tone: "success" } },
    ]);
  });
});

describe("discoverVariantCaptures — wired into extractMappedDataRefs (DashboardWithMaps fixture)", () => {
  const sourceFile = loadSourceFile(fixture("DashboardWithMaps.tsx"));
  const usages = extractMappedDataRefs(sourceFile);

  it("discovers StatCard.tone as the only variant axis, 3 candidates", () => {
    const stats = usageFor(usages, "StatCard");
    expect(stats.variantAxisFields).toEqual(["tone"]);
    expect(stats.variantCandidates).toEqual<VariantCaptureCandidate[]>([
      { instanceIndex: 0, propValues: { tone: "neutral" } },
      { instanceIndex: 1, propValues: { tone: "success" } },
      { instanceIndex: 2, propValues: { tone: "warning" } },
    ]);
  });

  it("discovers SessionCard.status as a variant axis, 2 candidates (fixture has 2 SESSIONS items) — plus learnerName here, since this fixture's names ('Amir'/'Sara') happen to be single enum-like tokens unlike the real app's full names", () => {
    const sessions = usageFor(usages, "SessionCard");
    expect(sessions.variantAxisFields).toContain("status");
    const statusCandidates = sessions.variantCandidates.filter((c) => "status" in c.propValues);
    expect(statusCandidates.map((c) => c.propValues.status)).toEqual(expect.arrayContaining(["completed", "scheduled"]));
  });
});

describe("discoverVariantCaptures — the real sample app (Issue.md's actual verification case)", () => {
  const sourceFile = loadSourceFile(sampleApp("src/screens/Dashboard.tsx"));
  const usages = extractMappedDataRefs(sourceFile);

  it("StatCard.tone: neutral/success/warning — the exact axis named in Issue.md", () => {
    const stats = usageFor(usages, "StatCard");
    expect(stats.variantAxisFields).toEqual(["tone"]);
    expect(stats.variantCandidates.map((c) => c.propValues.tone)).toEqual(["neutral", "success", "warning"]);
  });

  it("SessionCard.status: completed/scheduled/missed — the exact axis named in Issue.md", () => {
    const sessions = usageFor(usages, "SessionCard");
    expect(sessions.variantAxisFields).toEqual(["status"]);
    expect(sessions.variantCandidates.map((c) => c.propValues.status)).toEqual(["completed", "scheduled", "missed"]);
  });

  it("does not treat avatarSrc, learnerName, or the numeric score as variant axes", () => {
    const sessions = usageFor(usages, "SessionCard");
    expect(sessions.variantAxisFields).not.toContain("avatarSrc");
    expect(sessions.variantAxisFields).not.toContain("learnerName");
    expect(sessions.variantAxisFields).not.toContain("score");
  });

  it("Sidebar (no .map() at all) has no mappedDataRefs, so nothing to discover", () => {
    const sidebarSource = loadSourceFile(sampleApp("src/components/Sidebar.tsx"));
    expect(extractMappedDataRefs(sidebarSource)).toEqual([]);
  });
});
