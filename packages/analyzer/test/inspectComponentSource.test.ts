import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { inspectComponentSource } from "../src/ast/inspectComponentSource.js";

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/react/${name}`, import.meta.url));
}

describe("inspectComponentSource — Button (simple, variant/size props)", () => {
  const evidence = inspectComponentSource(fixture("Button.tsx"));

  it("finds the component and its export name", () => {
    expect(evidence.exportName).toBe("Button");
  });

  it("extracts variant as a variant-axis candidate (string literal union)", () => {
    const variant = evidence.props.find((p) => p.name === "variant");
    expect(variant?.literalValues).toEqual(["primary", "secondary"]);
    expect(variant?.required).toBe(true);
  });

  it("extracts size with its default value and optionality", () => {
    const size = evidence.props.find((p) => p.name === "size");
    expect(size?.literalValues).toEqual(["medium", "large"]);
    expect(size?.required).toBe(false);
    expect(size?.defaultValue).toBe('"medium"');
  });

  it("extracts disabled boolean prop with a default", () => {
    const disabled = evidence.props.find((p) => p.name === "disabled");
    expect(disabled?.tsType).toBe("boolean");
    expect(disabled?.defaultValue).toBe("false");
  });

  it("flags onClick as an event handler", () => {
    const onClick = evidence.props.find((p) => p.name === "onClick");
    expect(onClick?.isEventHandler).toBe(true);
  });

  it("captures the JSX outline rooted at <button>", () => {
    expect(evidence.jsx?.tag).toBe("button");
    expect(evidence.jsx?.attributes.className).toBe(true); // dynamic (template literal) — presence recorded, not resolved
  });

  it("has no imported components (host elements only)", () => {
    expect(evidence.importedComponents).toEqual([]);
  });
});

describe("inspectComponentSource — Card (nested host elements)", () => {
  const evidence = inspectComponentSource(fixture("Card.tsx"));

  it("captures nested div/h3 structure", () => {
    expect(evidence.jsx?.tag).toBe("div");
    const header = evidence.jsx?.children.find((c) => c.attributes.className === "card-header");
    expect(header).toBeDefined();
    const title = header?.children.find((c) => c.tag === "h3");
    expect(title).toBeDefined();
  });

  it("extracts required title and children props", () => {
    const title = evidence.props.find((p) => p.name === "title");
    expect(title?.required).toBe(true);
    expect(title?.tsType).toBe("string");
  });
});

describe("inspectComponentSource — SessionCard (nested component composition)", () => {
  const evidence = inspectComponentSource(fixture("SessionCard.tsx"));

  it("identifies Card, Avatar, and Badge as imported sub-components", () => {
    const names = evidence.importedComponents.map((c) => c.name).sort();
    expect(names).toEqual(["Avatar", "Badge", "Card"]);
    const card = evidence.importedComponents.find((c) => c.name === "Card");
    expect(card?.moduleSpecifier).toBe("./Card");
  });

  it("captures status as a variant-axis candidate", () => {
    const status = evidence.props.find((p) => p.name === "status");
    expect(status?.literalValues).toEqual(["scheduled", "completed", "missed"]);
  });

  it("JSX outline shows Card as the root, composing Avatar and Badge", () => {
    expect(evidence.jsx?.tag).toBe("Card");
    const row = evidence.jsx?.children.find((c) => c.attributes.className === "session-card-row");
    const childTags = row?.children.map((c) => c.tag);
    expect(childTags).toContain("Avatar");
    expect(childTags).toContain("Badge");
  });

  it("captures score as optional with no literal values (numeric prop)", () => {
    const score = evidence.props.find((p) => p.name === "score");
    expect(score?.required).toBe(false);
    expect(score?.literalValues).toBeUndefined();
  });
});
