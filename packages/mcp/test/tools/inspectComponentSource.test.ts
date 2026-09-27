import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { inspectComponentSourceTool } from "../../src/tools/inspectComponentSource.js";

const projectRoot = fileURLToPath(new URL("../fixtures", import.meta.url));

describe("inspectComponentSourceTool", () => {
  it("resolves sourceFile relative to projectRoot and returns AST evidence", async () => {
    const result = await inspectComponentSourceTool({ sourceFile: "react/Button.tsx" }, { projectRoot });
    expect(result.exportName).toBe("Button");
    const variant = result.props.find((p) => p.name === "variant");
    expect(variant?.literalValues).toEqual(["primary", "secondary"]);
  });

  it("respects an explicit exportName", async () => {
    const result = await inspectComponentSourceTool({ sourceFile: "react/Button.tsx", exportName: "Button" }, { projectRoot });
    expect(result.exportName).toBe("Button");
  });
});
