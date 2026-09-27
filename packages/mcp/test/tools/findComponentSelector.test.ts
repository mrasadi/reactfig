import { describe, it, expect } from "vitest";
import { findComponentSelectorTool } from "../../src/tools/findComponentSelector.js";
import type { FindComponentInstancesResult } from "@reactfig/analyzer";

function fakeFindInstances(result: FindComponentInstancesResult) {
  const calls: Array<{ url: string; componentName: string; viewport?: { width: number; height: number } }> = [];
  const fn = async (request: { url: string; componentName: string; viewport?: { width: number; height: number } }) => {
    calls.push(request);
    return result;
  };
  return Object.assign(fn, { calls });
}

describe("findComponentSelectorTool", () => {
  it("passes url/componentName/viewport straight through to the injected findInstances", async () => {
    const findInstances = fakeFindInstances({ componentName: "Avatar", matches: [] });

    await findComponentSelectorTool({ url: "http://localhost:3000", componentName: "Avatar", viewport: { width: 800, height: 600 } }, { findInstances });

    expect(findInstances.calls).toEqual([{ url: "http://localhost:3000", componentName: "Avatar", viewport: { width: 800, height: 600 } }]);
  });

  it("returns zero matches (not an error) when the component isn't rendered on the page", async () => {
    const findInstances = fakeFindInstances({ componentName: "Avatar", matches: [] });

    const result = await findComponentSelectorTool({ url: "http://localhost:3000", componentName: "Avatar" }, { findInstances });

    expect(result.matches).toEqual([]);
  });

  it("returns every match findInstances reports, e.g. several SessionCards' Avatar instances", async () => {
    const findInstances = fakeFindInstances({
      componentName: "Avatar",
      matches: [
        { selector: "div:nth-of-type(1) img", preview: "card 1", rect: { x: 0, y: 0, width: 48, height: 48 }, tag: "img" },
        { selector: "div:nth-of-type(2) img", preview: "card 2", rect: { x: 0, y: 100, width: 48, height: 48 }, tag: "img" },
      ],
    });

    const result = await findComponentSelectorTool({ url: "http://localhost:3000", componentName: "Avatar" }, { findInstances });

    expect(result.matches).toHaveLength(2);
    expect(result.matches[0].selector).toBe("div:nth-of-type(1) img");
    expect(result.matches[1].preview).toBe("card 2");
  });
});
