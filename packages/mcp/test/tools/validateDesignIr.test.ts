import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateDesignIrTool } from "../../src/tools/validateDesignIr.js";

function loadFixture(): unknown {
  const path = fileURLToPath(new URL("../../../artifact/test/fixtures/design-ir/button.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("validateDesignIrTool", () => {
  it("reports valid:true for a real design-ir/v1 document", async () => {
    const result = await validateDesignIrTool({ document: loadFixture() });
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("reports valid:false with errors for a malformed document", async () => {
    const result = await validateDesignIrTool({ document: { nonsense: true } });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
