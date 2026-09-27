import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { Project, ModuleResolutionKind, ts } from "ts-morph";
import { extractStaticUsageVariants } from "../src/ast/extractStaticUsageVariants.js";

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

/**
 * `ToolbarWithStaticButtons.tsx` deliberately has THREE different Button
 * situations in one file: (1) three call sites with genuinely different
 * literal `variant` values (the real target case — no `.map()`, no array,
 * just typed-out JSX), (2) two call sites with the SAME literal `variant`
 * (must not be proposed as an axis — nothing actually varies), and (3) two
 * more Button usages inside a `.map()` callback (must be excluded
 * entirely — that's extractMappedDataRefs's job, and counting one static
 * call site executed twice as "two static usages" would be wrong).
 */
describe("extractStaticUsageVariants — ToolbarWithStaticButtons (no .map(), just repeated call sites)", () => {
  const sourceFile = loadSourceFile(fixture("ToolbarWithStaticButtons.tsx"));
  const usages = extractStaticUsageVariants(sourceFile);

  it("finds Button and proposes `variant` as a variant axis from its literal prop values alone", () => {
    expect(usages).toHaveLength(1);
    const button = usages[0];
    expect(button.componentTag).toBe("Button");
    expect(button.variantAxisFields).toEqual(["variant"]);
  });

  it("excludes the two usages inside the .map() callback from the static usage count (5, not 6 or 7)", () => {
    const button = usages[0];
    expect(button.usageCount).toBe(5);
  });

  it("proposes one candidate per distinct value actually observed, in first-occurrence order — not one per call site", () => {
    const button = usages[0];
    // 5 static call sites, but only 3 distinct `variant` values
    // (primary/secondary/danger) — "Confirm"/"Retry" repeat "primary"
    // and must be deduped, not proposed again.
    expect(button.variantCandidates).toEqual([
      { instanceIndex: 0, propValues: { variant: "primary" } },
      { instanceIndex: 1, propValues: { variant: "secondary" } },
      { instanceIndex: 2, propValues: { variant: "danger" } },
    ]);
  });

  it("does not propose `label` as an axis — its values contain spaces, so they fail the same enum-token shape check .map()-driven discovery uses (ENUM_TOKEN_RE), even though every value happens to be distinct", () => {
    const button = usages[0];
    expect(button.variantAxisFields).toEqual(["variant"]); // not ["label", "variant"]
  });
});
