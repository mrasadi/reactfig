import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findUnresolvedExternalRefs, findNodePath, mergeDesignDocuments, buildInstanceOverridesFromPerInstanceData, applyVariantAssignments } from "../src/merge.js";
import { validateDesignIR } from "../src/validate.js";
import type { ComponentDef, ComponentSet, DesignDocument, Node } from "../src/types.js";

function loadFixture(name: string): DesignDocument {
  const path = fileURLToPath(new URL(`../../artifact/test/fixtures/design-ir/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8"));
}

function findInstance(node: Node, name: string): Extract<Node, { type: "instance" }> | undefined {
  if (node.type === "instance" && node.name === name) return node;
  if (node.type === "frame" || node.type === "group") {
    for (const child of node.children) {
      const found = findInstance(child, name);
      if (found) return found;
    }
  }
  return undefined;
}

function rootOf(comp: ComponentDef | ComponentSet): Node {
  return comp.kind === "component" ? comp.root : comp.variants[0].root;
}

describe("mergeDesignDocuments", () => {
  it("resolves external:Avatar to the real Avatar component, and reports external:Badge as unresolved when no Badge dependency is supplied", () => {
    const sessionCard = loadFixture("session-card");
    const avatar = loadFixture("avatar");

    const { document, unresolvedExternalRefs } = mergeDesignDocuments(sessionCard, [avatar]);

    expect(unresolvedExternalRefs).toEqual(["external:Badge"]);

    const sessionCardComp = document.components.find((c) => c.id === "comp_sessioncard")!;
    const avatarInstance = findInstance(rootOf(sessionCardComp), "Avatar")!;
    expect(avatarInstance.componentRef).toEqual({ kind: "component", componentId: "comp_avatar" });

    const badgeInstance = findInstance(rootOf(sessionCardComp), "Badge")!;
    expect(badgeInstance.componentRef).toEqual({ kind: "component", componentId: "external:Badge" });

    // The real Avatar component definition (and its asset) are now part of the merged document.
    expect(document.components.some((c) => c.id === "comp_avatar")).toBe(true);
  });

  it("resolves a componentSet dependency (Button, with variants) to a variant ref — not a bare componentId, which the Figma renderer's componentIndex never indexes for a set", () => {
    const sessionCard = loadFixture("session-card");
    const button = loadFixture("button");
    // session-card.json's fixture doesn't reference Button, so graft on an
    // instance that does, to exercise componentSet resolution specifically.
    const sessionCardComp = sessionCard.components.find((c) => c.id === "comp_sessioncard") as ComponentDef;
    const root = sessionCardComp.root as Extract<Node, { type: "frame" }>;
    root.children.push({
      type: "instance",
      id: "node_button_ref",
      name: "Button",
      bounds: { x: 0, y: 0, width: 100, height: 40 },
      componentRef: { kind: "component", componentId: "external:Button" },
    });

    const { document, unresolvedExternalRefs } = mergeDesignDocuments(sessionCard, [button]);

    expect(unresolvedExternalRefs.sort()).toEqual(["external:Avatar", "external:Badge"]);
    const buttonInstance = findInstance(rootOf(document.components.find((c) => c.id === "comp_sessioncard")!), "Button")!;
    // NOT { kind: "component", componentId: "comp_button" } — packages/figma-plugin's
    // componentIndex only ever stores componentSet variants under
    // `${setId}:${variantId}`, never a bare `comp_button` key (see
    // components.ts's buildComponentSet), so that shape would silently
    // fail to resolve at render time despite passing schema validation.
    expect(buttonInstance.componentRef).toEqual({ kind: "variant", componentSetId: "comp_button", variantId: "comp_button_primary_large" });
    expect(document.components.some((c) => c.id === "comp_button" && c.kind === "componentSet")).toBe(true);
  });

  it("namespaces an asset id referenced from a Fill (e.g. a CSS background-image), not just a direct ImageNode's assetId", () => {
    const sessionCard = loadFixture("session-card");
    const avatarWithBgFill: DesignDocument = {
      ...loadFixture("avatar"),
      components: [
        {
          kind: "component",
          id: "comp_avatar",
          name: "Avatar",
          root: {
            type: "frame",
            id: "node_avatar_frame",
            name: "Avatar",
            bounds: { x: 0, y: 0, width: 48, height: 48 },
            fills: [{ type: "image", assetId: "asset_0", scaleMode: "fill" }],
            children: [],
          },
        },
      ],
    };

    const { document } = mergeDesignDocuments(sessionCard, [avatarWithBgFill]);

    const avatarComp = document.components.find((c) => c.id === "comp_avatar") as ComponentDef;
    const fillAssetId = ((avatarComp.root as Extract<Node, { type: "frame" }>).fills![0] as { type: "image"; assetId: string }).assetId;
    // The Fill's assetId must point at an asset id that actually exists in
    // the merged document.assets — not the dependency's original, no
    // longer valid, "asset_0".
    expect(document.assets.some((a) => a.id === fillAssetId)).toBe(true);
    expect(fillAssetId).not.toBe("asset_0");
  });

  it("keeps only the first occurrence of a component id that appears in more than one input document, reports it as a duplicate, and doesn't leak the dropped duplicate's now-unreferenced asset", () => {
    const sessionCard = loadFixture("session-card");
    const avatarA = loadFixture("avatar");
    const avatarB = loadFixture("avatar"); // same component id (comp_avatar) both times

    const { document, duplicateComponentIds } = mergeDesignDocuments(sessionCard, [avatarA, avatarB]);

    expect(duplicateComponentIds).toEqual(["comp_avatar"]);
    expect(document.components.filter((c) => c.id === "comp_avatar")).toHaveLength(1);
    // avatarB's asset (namespaced as dep1_asset_0) must not end up in the
    // merged document at all — its component was dropped as a duplicate,
    // so nothing would reference it.
    expect(document.assets.some((a) => a.id === "dep1_asset_0")).toBe(false);
    expect(document.assets.filter((a) => a.id.endsWith("asset_0"))).toHaveLength(1);
  });

  it("namespaces dependency node ids and asset ids to avoid collisions across independently generated documents", () => {
    const sessionCard = loadFixture("session-card");
    // Two DIFFERENT components (different names/ids, so neither is a
    // duplicate of the other) that nonetheless reuse the same internal
    // node id and asset id — realistic, since generate_design_ir restarts
    // its id counters (node_..._0, asset_0, ...) on every call regardless
    // of which component it's analyzing.
    const makeAvatarLike = (name: string): DesignDocument => ({
      ...loadFixture("avatar"),
      components: [
        {
          kind: "component",
          id: `comp_${name.toLowerCase()}`,
          name,
          root: { type: "image", id: "node_avatar_image", name: "Image", bounds: { x: 0, y: 0, width: 48, height: 48 }, assetId: "asset_0" },
        },
      ],
    });
    const avatarA = makeAvatarLike("Avatar");
    const avatarB = makeAvatarLike("AvatarLarge");

    const { document, duplicateComponentIds } = mergeDesignDocuments(sessionCard, [avatarA, avatarB]);

    expect(duplicateComponentIds).toEqual([]);
    expect(document.components.some((c) => c.id === "comp_avatar")).toBe(true);
    expect(document.components.some((c) => c.id === "comp_avatarlarge")).toBe(true);

    const nodeIds = new Set<string>();
    const assetIds = new Set(document.assets.map((a) => a.id));
    expect(assetIds.size).toBe(document.assets.length); // no asset id collisions

    function collect(node: Node) {
      expect(nodeIds.has(node.id)).toBe(false);
      nodeIds.add(node.id);
      if (node.type === "frame" || node.type === "group") node.children.forEach(collect);
    }
    for (const comp of document.components) {
      if (comp.kind === "component") collect(comp.root);
      else comp.variants.forEach((v) => collect(v.root));
    }

    // And every image node's assetId genuinely resolves within the merged assets, per component.
    for (const comp of document.components) {
      if (comp.kind !== "component" || comp.root.type !== "image") continue;
      expect(document.assets.some((a) => a.id === comp.root.assetId)).toBe(true);
    }
  });

  it("produces a document that still passes design-ir/v1 validation", () => {
    const sessionCard = loadFixture("session-card");
    const avatar = loadFixture("avatar");
    const button = loadFixture("button");

    const { document } = mergeDesignDocuments(sessionCard, [avatar, button]);
    const result = validateDesignIR(document);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("leaves the primary document's own pages, id, name, and meta untouched", () => {
    const sessionCard = loadFixture("session-card");
    const avatar = loadFixture("avatar");

    const { document } = mergeDesignDocuments(sessionCard, [avatar]);

    expect(document.id).toBe(sessionCard.id);
    expect(document.name).toBe(sessionCard.name);
    expect(document.meta).toEqual(sessionCard.meta);
    expect(document.pages).toEqual(sessionCard.pages);
  });
});

describe("findUnresolvedExternalRefs", () => {
  it("finds every unresolved external:<Name> ref left in a document that never went through mergeDesignDocuments at all", () => {
    // Exactly the scenario export_design_artifact must guard against: a
    // caller that skipped merge_design_ir_documents entirely, not just one
    // where merge ran but didn't have every dependency.
    const sessionCard = loadFixture("session-card");
    expect(findUnresolvedExternalRefs(sessionCard).sort()).toEqual(["external:Avatar", "external:Badge"]);
  });

  it("finds only the refs a partial merge left unresolved, matching mergeDesignDocuments' own unresolvedExternalRefs for the same inputs", () => {
    const sessionCard = loadFixture("session-card");
    const avatar = loadFixture("avatar");
    const { document, unresolvedExternalRefs } = mergeDesignDocuments(sessionCard, [avatar]);
    expect(findUnresolvedExternalRefs(document).sort()).toEqual([...unresolvedExternalRefs].sort());
  });

  it("agrees with mergeDesignDocuments' own unresolvedExternalRefs report across the full dependency set (session-card, avatar, and button)", () => {
    const sessionCard = loadFixture("session-card");
    const avatar = loadFixture("avatar");
    const button = loadFixture("button");
    const { document, unresolvedExternalRefs } = mergeDesignDocuments(sessionCard, [avatar, button]);
    expect(findUnresolvedExternalRefs(document).sort()).toEqual([...unresolvedExternalRefs].sort());
  });

  it("returns [] for a document with no instance nodes at all", () => {
    const avatar = loadFixture("avatar");
    expect(findUnresolvedExternalRefs(avatar)).toEqual([]);
  });
});
describe("findNodePath (Issue.md Fix 2c — locating an override target without hand-counting indices)", () => {
  it("finds a direct child of the component root", () => {
    const sessionCard = loadFixture("session-card");
    const path = findNodePath(sessionCard, "comp_sessioncard", "node_card_title");
    expect(path).toEqual([0]);
  });

  it("returns [] when the target id IS the component root", () => {
    const sessionCard = loadFixture("session-card");
    const path = findNodePath(sessionCard, "comp_sessioncard", "node_card_root");
    expect(path).toEqual([]);
  });

  it("crosses transparently into a nested instance's own referenced component — no extra index consumed for the crossing itself", () => {
    const sessionCard = loadFixture("session-card");
    const avatar = loadFixture("avatar");
    const { document } = mergeDesignDocuments(sessionCard, [avatar]);
    // comp_avatar's root IS node_avatar_image (a bare ImageNode, no frame
    // wrapper) — so the path to it is just the path to the Avatar
    // instance itself: session-card-row (index 1) -> Avatar instance
    // (index 0). Reaching *into* the crossed component adds no index of
    // its own; only descending further inside it would.
    const path = findNodePath(document, "comp_sessioncard", "dep0_node_avatar_image");
    expect(path).toEqual([1, 0]);
  });

  it("returns null for an id that doesn't exist anywhere in the component", () => {
    const sessionCard = loadFixture("session-card");
    expect(findNodePath(sessionCard, "comp_sessioncard", "does_not_exist")).toBeNull();
  });

  it("returns null for an unknown componentId", () => {
    const sessionCard = loadFixture("session-card");
    expect(findNodePath(sessionCard, "comp_nope", "node_card_title")).toBeNull();
  });
});

describe("mergeDesignDocuments — instanceOverrides (Issue.md Fix 2c: per-instance content for repeated template components)", () => {
  it("applies a text override onto the matching instance node — even one resolved from an external:<Name> ref onto a componentSet variant (e.g. per-instance Button/Badge label text)", () => {
    const sessionCard = loadFixture("session-card");
    const button = loadFixture("button");
    const sessionCardComp = sessionCard.components.find((c) => c.id === "comp_sessioncard") as ComponentDef;
    const root = sessionCardComp.root as Extract<Node, { type: "frame" }>;
    // A second Button-like instance, simulating a `.map()`-rendered
    // sibling — only one of the two gets an override.
    root.children.push(
      { type: "instance", id: "node_button_a", name: "Button", bounds: { x: 0, y: 0, width: 100, height: 40 }, componentRef: { kind: "component", componentId: "external:Button" } },
      { type: "instance", id: "node_button_b", name: "Button", bounds: { x: 0, y: 50, width: 100, height: 40 }, componentRef: { kind: "component", componentId: "external:Button" } }
    );

    const { document } = mergeDesignDocuments(sessionCard, [button], {
      node_button_a: [{ path: [0], characters: "Start now" }],
    });

    const comp = document.components.find((c) => c.id === "comp_sessioncard")!;
    const frameRoot = (comp as { root: { children: Array<{ id: string; overrides?: unknown }> } }).root;
    const overridden = frameRoot.children.find((c) => c.id === "node_button_a")!;
    const untouched = frameRoot.children.find((c) => c.id === "node_button_b")!;

    // node_button_label is child [0] of the resolved variant's root (see
    // button.json) — reachable the same way whether the instance's
    // componentRef started out unresolved or not.
    expect(overridden.overrides).toEqual([{ path: [0], characters: "Start now" }]);
    expect(untouched.overrides).toBeUndefined();
  });

  it("applies a fill override to a nested instance addressed by its own id, with an empty path targeting its bare (childless) root directly (e.g. an Avatar's image swapped for a color-coded fill)", () => {
    const sessionCard = loadFixture("session-card");
    const avatar = loadFixture("avatar");
    const green = { r: 0, g: 0.6, b: 0.3, a: 1 };

    const { document } = mergeDesignDocuments(sessionCard, [avatar], {
      node_avatar_instance: [{ path: [], fills: [{ type: "solid", color: green }] }],
    });

    const comp = document.components.find((c) => c.id === "comp_sessioncard")!;
    const frameRoot = (comp as { root: { children: Array<{ id: string; children?: unknown[] }> } }).root;
    const row = frameRoot.children[1] as { children: Array<{ id: string; overrides?: unknown }> };
    const avatarInstance = row.children.find((c) => c.id === "node_avatar_instance")!;
    expect(avatarInstance.overrides).toEqual([{ path: [], fills: [{ type: "solid", color: green }] }]);
  });

  it("is a no-op when no override matches any instance id in the primary document", () => {
    const sessionCard = loadFixture("session-card");
    const avatar = loadFixture("avatar");
    const { document } = mergeDesignDocuments(sessionCard, [avatar], {
      node_does_not_exist: [{ path: [], characters: "unused" }],
    });
    const comp = document.components.find((c) => c.id === "comp_sessioncard")!;
    const frameRoot = (comp as { root: { children: Array<{ overrides?: unknown }> } }).root;
    expect(frameRoot.children.every((c) => c.overrides === undefined)).toBe(true);
  });
});

describe("buildInstanceOverridesFromPerInstanceData — auto-deriving instanceOverrides from raw perInstanceData (Issue.md follow-up: fixes the caller having to hand-build InstanceOverride paths, which one real run got wrong)", () => {
  function dashboardWithThreeStatCards(): DesignDocument {
    return {
      $schema: "https://reactfig.dev/schema/design-ir/v1.json",
      version: "design-ir/v1",
      id: "dashboard-primary",
      name: "Dashboard",
      pages: [],
      assets: [],
      meta: { generator: "test", generatedAt: "2026-01-01T00:00:00Z" },
      components: [
        {
          kind: "component",
          id: "comp_dashboard",
          name: "Dashboard",
          root: {
            type: "frame",
            id: "node_dashboard_root",
            name: "Dashboard",
            bounds: { x: 0, y: 0, width: 800, height: 200 },
            children: [
              { type: "instance", id: "node_stat_0", name: "StatCard", bounds: { x: 0, y: 0, width: 200, height: 100 }, componentRef: { kind: "component", componentId: "external:StatCard" } },
              { type: "instance", id: "node_stat_1", name: "StatCard", bounds: { x: 200, y: 0, width: 200, height: 100 }, componentRef: { kind: "component", componentId: "external:StatCard" } },
              { type: "instance", id: "node_stat_2", name: "StatCard", bounds: { x: 400, y: 0, width: 200, height: 100 }, componentRef: { kind: "component", componentId: "external:StatCard" } },
            ],
          },
        },
      ],
    };
  }

  function statCardDep(): DesignDocument {
    return {
      $schema: "https://reactfig.dev/schema/design-ir/v1.json",
      version: "design-ir/v1",
      id: "statcard-dep",
      name: "StatCard",
      pages: [],
      assets: [],
      meta: { generator: "test", generatedAt: "2026-01-01T00:00:00Z" },
      components: [
        {
          kind: "component",
          id: "comp_stat_card",
          name: "StatCard",
          root: {
            type: "frame",
            id: "node_statcard_root",
            name: "StatCard",
            bounds: { x: 0, y: 0, width: 200, height: 100 },
            children: [
              { type: "text", id: "node_statcard_value", name: "Value", bounds: { x: 0, y: 0, width: 200, height: 40 }, characters: "12", typography: { fontFamily: "Inter", fontWeight: 700, fontSize: 24 } },
              { type: "text", id: "node_statcard_label", name: "Label", bounds: { x: 0, y: 40, width: 200, height: 20 }, characters: "Sessions this week", typography: { fontFamily: "Inter", fontWeight: 400, fontSize: 12 } },
            ],
          },
        },
      ],
    };
  }

  const perInstanceData = {
    StatCard: [
      { label: "Sessions this week", value: "12", tone: "neutral" },
      { label: "Avg. speaking score", value: "6.8", tone: "success" },
      { label: "Missed sessions", value: "1", tone: "warning" },
    ],
  };

  it("derives correct per-instance overrides for all 3 StatCards, matched against the merged (external-ref-resolved) document", () => {
    const { document } = mergeDesignDocuments(dashboardWithThreeStatCards(), [statCardDep()]);
    const primaryComponents = document.components.filter((c) => c.id === "comp_dashboard");

    const { instanceOverrides, warnings } = buildInstanceOverridesFromPerInstanceData(primaryComponents, document.components, document.assets, perInstanceData);

    expect(warnings).toEqual([
      'buildInstanceOverridesFromPerInstanceData: "StatCard" — could not find a captured text node or image asset matching field(s) tone (checked against the first item\'s values, and — for image-path-looking values — against the component\'s own unclaimed image slots); these fields won\'t be overridden on any instance.',
    ]);
    expect(Object.keys(instanceOverrides).sort()).toEqual(["node_stat_0", "node_stat_1", "node_stat_2"]);

    // Field->path resolution is shared, so every instance's overrides target the same two paths.
    const paths0 = instanceOverrides.node_stat_0.map((o) => o.path).sort();
    const paths1 = instanceOverrides.node_stat_1.map((o) => o.path).sort();
    expect(paths0).toEqual(paths1);

    const values = (id: string) => instanceOverrides[id].map((o) => o.characters).sort();
    expect(values("node_stat_0")).toEqual(["12", "Sessions this week"]);
    expect(values("node_stat_1")).toEqual(["6.8", "Avg. speaking score"]);
    expect(values("node_stat_2")).toEqual(["1", "Missed sessions"]);
  });

  it("the derived overrides, once applied via mergeDesignDocuments, actually render three distinct StatCards — not the identical-instance bug", () => {
    const primary = dashboardWithThreeStatCards();
    const dep = statCardDep();
    const { document: preview } = mergeDesignDocuments(primary, [dep]);
    const { instanceOverrides } = buildInstanceOverridesFromPerInstanceData(
      preview.components.filter((c) => c.id === "comp_dashboard"),
      preview.components,
      preview.assets,
      perInstanceData
    );

    const { document: final } = mergeDesignDocuments(dashboardWithThreeStatCards(), [statCardDep()], instanceOverrides);
    const dashboardRoot = (final.components.find((c) => c.id === "comp_dashboard") as ComponentDef).root as Extract<Node, { type: "frame" }>;
    const overridesByInstance = dashboardRoot.children.map((c) => (c as { overrides?: Array<{ characters?: string }> }).overrides?.map((o) => o.characters).sort());
    expect(overridesByInstance).toEqual([["12", "Sessions this week"], ["6.8", "Avg. speaking score"], ["1", "Missed sessions"]]);
  });

  it("warns and skips a componentTag with no matching component in the document", () => {
    const { document } = mergeDesignDocuments(dashboardWithThreeStatCards(), [statCardDep()]);
    const { instanceOverrides, warnings } = buildInstanceOverridesFromPerInstanceData(
      document.components.filter((c) => c.id === "comp_dashboard"),
      document.components,
      document.assets,
      { NoSuchComponent: [{ label: "x" }] }
    );
    expect(instanceOverrides).toEqual({});
    expect(warnings[0]).toMatch(/no component named "NoSuchComponent"/);
  });

  it("warns when a field's value doesn't match any captured text node, but still overrides the fields that do match", () => {
    const { document } = mergeDesignDocuments(dashboardWithThreeStatCards(), [statCardDep()]);
    const { instanceOverrides, warnings } = buildInstanceOverridesFromPerInstanceData(
      document.components.filter((c) => c.id === "comp_dashboard"),
      document.components,
      document.assets,
      { StatCard: [{ value: "12", tone: "neutral" }] } // "tone" never appears as its own text node
    );
    expect(warnings.some((w) => w.includes("tone"))).toBe(true);
    expect(instanceOverrides.node_stat_0).toEqual([{ path: [0], characters: "12" }]);
  });

  it("warns on an instance-count mismatch and still overrides as many as it can", () => {
    const { document } = mergeDesignDocuments(dashboardWithThreeStatCards(), [statCardDep()]);
    const { instanceOverrides, warnings } = buildInstanceOverridesFromPerInstanceData(
      document.components.filter((c) => c.id === "comp_dashboard"),
      document.components,
      document.assets,
      { StatCard: [perInstanceData.StatCard[0]] } // only 1 item for 3 instances
    );
    expect(warnings.some((w) => w.includes("3 instance(s)") && w.includes("1 item(s)"))).toBe(true);
    expect(Object.keys(instanceOverrides)).toEqual(["node_stat_0"]);
  });

  it("warns when perInstanceData is supplied for a component with no instances in the primary document", () => {
    const { document } = mergeDesignDocuments(dashboardWithThreeStatCards(), [statCardDep()]);
    const { instanceOverrides, warnings } = buildInstanceOverridesFromPerInstanceData(
      document.components.filter((c) => c.id === "comp_dashboard"),
      document.components,
      document.assets,
      { SomeOtherComponent: [{ label: "x" }] }
    );
    expect(instanceOverrides).toEqual({});
    expect(warnings[0]).toMatch(/no component named "SomeOtherComponent"/);
  });
});

describe("buildInstanceOverridesFromPerInstanceData + applyVariantAssignments — variant selection per instance (the '3 StatCards defaulted to the same variant' bug)", () => {
  function dashboardWithThreeStatCards(): DesignDocument {
    return {
      $schema: "https://reactfig.dev/schema/design-ir/v1.json",
      version: "design-ir/v1",
      id: "dashboard-primary",
      name: "Dashboard",
      pages: [],
      assets: [],
      meta: { generator: "test", generatedAt: "2026-01-01T00:00:00Z" },
      components: [
        {
          kind: "component",
          id: "comp_dashboard",
          name: "Dashboard",
          root: {
            type: "frame",
            id: "node_dashboard_root",
            name: "Dashboard",
            bounds: { x: 0, y: 0, width: 800, height: 200 },
            children: [
              { type: "instance", id: "node_stat_0", name: "StatCard", bounds: { x: 0, y: 0, width: 200, height: 100 }, componentRef: { kind: "component", componentId: "external:StatCard" } },
              { type: "instance", id: "node_stat_1", name: "StatCard", bounds: { x: 200, y: 0, width: 200, height: 100 }, componentRef: { kind: "component", componentId: "external:StatCard" } },
              { type: "instance", id: "node_stat_2", name: "StatCard", bounds: { x: 400, y: 0, width: 200, height: 100 }, componentRef: { kind: "component", componentId: "external:StatCard" } },
            ],
          },
        },
      ],
    };
  }

  function statCardVariant(id: string, tone: string, value: string, label: string, strokeColor: { r: number; g: number; b: number; a: number }): ComponentSet["variants"][number] {
    return {
      id,
      propertyValues: { tone },
      root: {
        type: "frame",
        id: `node_root_${id}`,
        name: "StatCard",
        bounds: { x: 0, y: 0, width: 200, height: 100 },
        strokes: [{ color: strokeColor, width: 4, style: "solid" }],
        children: [
          { type: "text", id: `node_value_${id}`, name: "Value", bounds: { x: 0, y: 0, width: 200, height: 40 }, characters: value, typography: { fontFamily: "Inter", fontWeight: 700, fontSize: 24 } },
          { type: "text", id: `node_label_${id}`, name: "Label", bounds: { x: 0, y: 40, width: 200, height: 20 }, characters: label, typography: { fontFamily: "Inter", fontWeight: 400, fontSize: 12 } },
        ],
      },
    };
  }

  function statCardComponentSetDep(): DesignDocument {
    return {
      $schema: "https://reactfig.dev/schema/design-ir/v1.json",
      version: "design-ir/v1",
      id: "statcard-dep",
      name: "StatCard",
      pages: [],
      assets: [],
      meta: { generator: "test", generatedAt: "2026-01-01T00:00:00Z" },
      components: [
        {
          kind: "componentSet",
          id: "comp_stat_card",
          name: "StatCard",
          variantProperties: [{ name: "tone", values: ["neutral", "success", "warning"] }],
          variants: [
            statCardVariant("comp_stat_card_v0", "neutral", "12", "Sessions this week", { r: 0.42, g: 0.45, b: 0.5, a: 1 }),
            statCardVariant("comp_stat_card_v1", "success", "6.8", "Avg. speaking score", { r: 0.08, g: 0.66, b: 0.39, a: 1 }),
            statCardVariant("comp_stat_card_v2", "warning", "1", "Missed sessions", { r: 0.69, g: 0.42, b: 0, a: 1 }),
          ],
        },
      ],
    };
  }

  const perInstanceData = {
    StatCard: [
      { label: "Sessions this week", value: "12", tone: "neutral" },
      { label: "Avg. speaking score", value: "6.8", tone: "success" },
      { label: "Missed sessions", value: "1", tone: "warning" },
    ],
  };

  it("mergeDesignDocuments alone defaults every StatCard instance to the first variant (neutral) — reproducing the reported bug before this fix", () => {
    const { document } = mergeDesignDocuments(dashboardWithThreeStatCards(), [statCardComponentSetDep()]);
    const dashboardRoot = (document.components.find((c) => c.id === "comp_dashboard") as ComponentDef).root as Extract<Node, { type: "frame" }>;
    const variantIds = dashboardRoot.children.map((c) => (c as Extract<Node, { type: "instance" }>).componentRef).map((r) => (r.kind === "variant" ? r.variantId : r));
    expect(variantIds).toEqual(["comp_stat_card_v0", "comp_stat_card_v0", "comp_stat_card_v0"]);
  });

  it("buildInstanceOverridesFromPerInstanceData derives a distinct variantAssignment per instance, matching each item's own tone against StatCard's captured variants", () => {
    const { document } = mergeDesignDocuments(dashboardWithThreeStatCards(), [statCardComponentSetDep()]);
    const primaryComponents = document.components.filter((c) => c.id === "comp_dashboard");
    const { variantAssignments, warnings } = buildInstanceOverridesFromPerInstanceData(primaryComponents, document.components, document.assets, perInstanceData);

    expect(warnings.filter((w) => w.includes("no captured variant has that value"))).toEqual([]);
    expect(variantAssignments).toEqual({
      node_stat_0: "comp_stat_card_v0",
      node_stat_1: "comp_stat_card_v1",
      node_stat_2: "comp_stat_card_v2",
    });
  });

  it("applying the derived variantAssignments (via applyVariantAssignments) makes all three StatCards resolve to their own distinct tone/border — the actual end-to-end fix", () => {
    const primary = dashboardWithThreeStatCards();
    const dep = statCardComponentSetDep();
    const { document: preview } = mergeDesignDocuments(primary, [dep]);
    const { instanceOverrides, variantAssignments } = buildInstanceOverridesFromPerInstanceData(
      preview.components.filter((c) => c.id === "comp_dashboard"),
      preview.components,
      preview.assets,
      perInstanceData
    );

    const { document: final } = mergeDesignDocuments(dashboardWithThreeStatCards(), [statCardComponentSetDep()], instanceOverrides);
    applyVariantAssignments(final.components, variantAssignments);

    const statCardSet = final.components.find((c) => c.id === "comp_stat_card") as ComponentSet;
    const dashboardRoot = (final.components.find((c) => c.id === "comp_dashboard") as ComponentDef).root as Extract<Node, { type: "frame" }>;
    const strokeColors = dashboardRoot.children.map((c) => {
      const ref = (c as Extract<Node, { type: "instance" }>).componentRef;
      if (ref.kind !== "variant") throw new Error("expected variant ref");
      const variant = statCardSet.variants.find((v) => v.id === ref.variantId)!;
      return JSON.stringify((variant.root as Extract<Node, { type: "frame" }>).strokes?.[0]?.color);
    });
    // Three genuinely distinct stroke colors — not the same neutral border on all three.
    expect(new Set(strokeColors).size).toBe(3);
  });

  it("leaves an instance on its current (default) variant and warns, when its item's value doesn't match any captured variant", () => {
    const { document } = mergeDesignDocuments(dashboardWithThreeStatCards(), [statCardComponentSetDep()]);
    const primaryComponents = document.components.filter((c) => c.id === "comp_dashboard");
    const { variantAssignments, warnings } = buildInstanceOverridesFromPerInstanceData(primaryComponents, document.components, document.assets, {
      StatCard: [{ tone: "neutral" }, { tone: "danger" /* not a captured variant */ }, { tone: "warning" }],
    });
    expect(variantAssignments).toEqual({ node_stat_0: "comp_stat_card_v0", node_stat_2: "comp_stat_card_v2" });
    expect(warnings.some((w) => w.includes("danger") && w.includes("no captured variant"))).toBe(true);
  });

  function statCardComponentSetDepWithAxisName(axisName: string): DesignDocument {
    const doc = statCardComponentSetDep();
    const comp = doc.components[0] as ComponentSet;
    comp.variantProperties = [{ name: axisName, values: ["neutral", "success", "warning"] }];
    for (const v of comp.variants) v.propertyValues = { [axisName]: v.propertyValues.tone };
    return doc;
  }

  it("real bug reproduction: falls back to matching a field by VALUE (against the axis's own known values) when the captured variant axis name doesn't match any perInstanceData key at all — this is what silently defaulted every StatCard to the same variant before this fix, with zero warning", () => {
    // The componentSet's own confirmed axis is \"cardTone\" (as an AI
    // interpretation step might name it), but perInstanceData's own
    // field is \"tone\" (the raw source data's own field name) — two
    // independent naming processes with no guaranteed correspondence.
    const { document } = mergeDesignDocuments(dashboardWithThreeStatCards(), [statCardComponentSetDepWithAxisName("cardTone")]);
    const primaryComponents = document.components.filter((c) => c.id === "comp_dashboard");
    const { variantAssignments, warnings } = buildInstanceOverridesFromPerInstanceData(primaryComponents, document.components, document.assets, {
      StatCard: [
        { label: "Sessions this week", value: "12", tone: "neutral" },
        { label: "Avg. speaking score", value: "6.8", tone: "success" },
        { label: "Missed sessions", value: "1", tone: "warning" },
      ],
    });
    expect(variantAssignments).toEqual({
      node_stat_0: "comp_stat_card_v0",
      node_stat_1: "comp_stat_card_v1",
      node_stat_2: "comp_stat_card_v2",
    });
    // No warning about the axis-name mismatch itself, since the fallback
    // resolved it unambiguously — this must NOT be silent success without
    // a trace, but it's also not an error; nothing to warn about here.
    expect(warnings.some((w) => w.includes("no field named"))).toBe(false);
  });

  it("warns (rather than silently leaving every instance on the default variant) when the axis name doesn't match any key AND no field's value matches any of the axis's known values either", () => {
    const { document } = mergeDesignDocuments(dashboardWithThreeStatCards(), [statCardComponentSetDepWithAxisName("cardTone")]);
    const primaryComponents = document.components.filter((c) => c.id === "comp_dashboard");
    const { variantAssignments, warnings } = buildInstanceOverridesFromPerInstanceData(primaryComponents, document.components, document.assets, {
      // "mood" isn't "cardTone", and none of its values ("chill", "energetic", "tense") are among the axis's own known values.
      StatCard: [
        { label: "Sessions this week", value: "12", mood: "chill" },
        { label: "Avg. speaking score", value: "6.8", mood: "energetic" },
        { label: "Missed sessions", value: "1", mood: "tense" },
      ],
    });
    expect(variantAssignments).toEqual({});
    expect(warnings.some((w) => w.includes("no field named") && w.includes("cardTone"))).toBe(true);
  });

  it("warns and leaves the instance on its current variant (rather than guessing) when more than one field's value matches the axis's known values", () => {
    const { document } = mergeDesignDocuments(dashboardWithThreeStatCards(), [statCardComponentSetDepWithAxisName("cardTone")]);
    const primaryComponents = document.components.filter((c) => c.id === "comp_dashboard");
    const { variantAssignments, warnings } = buildInstanceOverridesFromPerInstanceData(primaryComponents, document.components, document.assets, {
      // Both "tone" and "fallbackTone" happen to have values from the axis's own known set — genuinely ambiguous.
      StatCard: [{ label: "Sessions this week", value: "12", tone: "neutral", fallbackTone: "success" }],
    });
    expect(variantAssignments).toEqual({});
    expect(warnings.some((w) => w.includes("more than one field") && w.includes("tone") && w.includes("fallbackTone"))).toBe(true);
  });
});


describe("buildInstanceOverridesFromPerInstanceData — image fields (Issue.md real-run follow-up: avatarSrc was reported unmatched, since it's not text)", () => {
  const CAPTURED_AVATAR_URL = "http://localhost:5173/avatars/amir.png";

  function dashboardWithThreeSessionCards(): DesignDocument {
    return {
      $schema: "https://reactfig.dev/schema/design-ir/v1.json",
      version: "design-ir/v1",
      id: "dashboard-primary",
      name: "Dashboard",
      pages: [],
      assets: [],
      meta: { generator: "test", generatedAt: "2026-01-01T00:00:00Z" },
      components: [
        {
          kind: "component",
          id: "comp_dashboard",
          name: "Dashboard",
          root: {
            type: "frame",
            id: "node_dashboard_root",
            name: "Dashboard",
            bounds: { x: 0, y: 0, width: 800, height: 200 },
            children: [
              { type: "instance", id: "node_session_0", name: "SessionCard", bounds: { x: 0, y: 0, width: 200, height: 100 }, componentRef: { kind: "component", componentId: "external:SessionCard" } },
              { type: "instance", id: "node_session_1", name: "SessionCard", bounds: { x: 200, y: 0, width: 200, height: 100 }, componentRef: { kind: "component", componentId: "external:SessionCard" } },
              { type: "instance", id: "node_session_2", name: "SessionCard", bounds: { x: 400, y: 0, width: 200, height: 100 }, componentRef: { kind: "component", componentId: "external:SessionCard" } },
            ],
          },
        },
      ],
    };
  }

  function sessionCardDep(): DesignDocument {
    return {
      $schema: "https://reactfig.dev/schema/design-ir/v1.json",
      version: "design-ir/v1",
      id: "sessioncard-dep",
      name: "SessionCard",
      pages: [],
      assets: [{ id: "asset_avatar_amir", path: CAPTURED_AVATAR_URL, mimeType: "image/png", width: 48, height: 48 }],
      meta: { generator: "test", generatedAt: "2026-01-01T00:00:00Z" },
      components: [
        {
          kind: "component",
          id: "comp_session_card",
          name: "SessionCard",
          root: {
            type: "frame",
            id: "node_sessioncard_root",
            name: "SessionCard",
            bounds: { x: 0, y: 0, width: 200, height: 100 },
            children: [
              { type: "image", id: "node_sessioncard_avatar", name: "Avatar", bounds: { x: 0, y: 0, width: 48, height: 48 }, assetId: "asset_avatar_amir" },
              { type: "text", id: "node_sessioncard_name", name: "Name", bounds: { x: 0, y: 48, width: 200, height: 20 }, characters: "Amir Hosseini", typography: { fontFamily: "Inter", fontWeight: 700, fontSize: 14 } },
            ],
          },
        },
      ],
    };
  }

  const perInstanceData = {
    SessionCard: [
      { learnerName: "Amir Hosseini", avatarSrc: "/avatars/amir.png" },
      { learnerName: "Sara Ahmadi", avatarSrc: "/avatars/sara.png" },
      { learnerName: "Dana Karimi", avatarSrc: "/avatars/dana.png" },
    ],
  };

  it("matches avatarSrc against the captured Avatar image's asset URL and derives a fills override with a new asset per learner — the actual fix for 'every SessionCard shows the same photo'", () => {
    const { document } = mergeDesignDocuments(dashboardWithThreeSessionCards(), [sessionCardDep()]);
    const primaryComponents = document.components.filter((c) => c.id === "comp_dashboard");

    const { instanceOverrides, newAssets, warnings } = buildInstanceOverridesFromPerInstanceData(primaryComponents, document.components, document.assets, perInstanceData);

    expect(warnings).toEqual([]);

    // Amir (item 0) matches the already-captured asset exactly — no new asset needed for
    // him; the resolved document's asset id is namespaced ("dep0_...") by mergeDesignDocuments,
    // so look it up dynamically rather than assuming the pre-merge id survived.
    const resolvedAmirAssetId = document.assets.find((a) => a.path === CAPTURED_AVATAR_URL)!.id;
    expect(instanceOverrides.node_session_0).toEqual(
      expect.arrayContaining([{ path: expect.any(Array), fills: [{ type: "image", assetId: resolvedAmirAssetId }] }])
    );

    // Sara and Dana each get a distinct new asset, with a URL built from the same base as the captured one.
    expect(newAssets).toHaveLength(2);
    const byPath = Object.fromEntries(newAssets.map((a) => [a.path, a]));
    expect(byPath["http://localhost:5173/avatars/sara.png"]).toBeDefined();
    expect(byPath["http://localhost:5173/avatars/dana.png"]).toBeDefined();
    // Carries over the matched asset's mimeType/dimensions — same avatar shape.
    expect(byPath["http://localhost:5173/avatars/sara.png"].mimeType).toBe("image/png");
    expect(byPath["http://localhost:5173/avatars/sara.png"].width).toBe(48);

    const saraAssetId = byPath["http://localhost:5173/avatars/sara.png"].id;
    const danaAssetId = byPath["http://localhost:5173/avatars/dana.png"].id;
    expect(instanceOverrides.node_session_1).toEqual(expect.arrayContaining([{ path: expect.any(Array), fills: [{ type: "image", assetId: saraAssetId }] }]));
    expect(instanceOverrides.node_session_2).toEqual(expect.arrayContaining([{ path: expect.any(Array), fills: [{ type: "image", assetId: danaAssetId }] }]));

    // Text field (learnerName) still resolves normally alongside the image field.
    const namesByInstance = ["node_session_0", "node_session_1", "node_session_2"].map(
      (id) => instanceOverrides[id].find((o) => o.characters !== undefined)?.characters
    );
    expect(namesByInstance).toEqual(["Amir Hosseini", "Sara Ahmadi", "Dana Karimi"]);
  });

  it("once applied through mergeDesignDocuments, each SessionCard instance's Avatar resolves to a different assetId — not the same photo repeated", () => {
    const primary = dashboardWithThreeSessionCards();
    const dep = sessionCardDep();
    const { document: preview } = mergeDesignDocuments(primary, [dep]);
    const { instanceOverrides, newAssets } = buildInstanceOverridesFromPerInstanceData(
      preview.components.filter((c) => c.id === "comp_dashboard"),
      preview.components,
      preview.assets,
      perInstanceData
    );

    const { document: final } = mergeDesignDocuments(dashboardWithThreeSessionCards(), [sessionCardDep()], instanceOverrides);
    final.assets.push(...newAssets); // mirrors what mergeDesignIrCheckpointsTool does with derived.newAssets

    const dashboardRoot = (final.components.find((c) => c.id === "comp_dashboard") as ComponentDef).root as Extract<Node, { type: "frame" }>;
    const avatarAssetIds = dashboardRoot.children.map((c) => {
      const overrides = (c as { overrides?: InstanceOverride[] }).overrides ?? [];
      return overrides.find((o) => o.fills)?.fills?.[0];
    });
    const assetIds = avatarAssetIds.map((f) => (f && "assetId" in f ? f.assetId : undefined));
    expect(new Set(assetIds).size).toBe(3); // three distinct assets, not one repeated
    expect(final.assets.map((a) => a.id)).toEqual(expect.arrayContaining(assetIds.filter((id): id is string => !!id)));
  });

  it("the image-slot fallback matches an image-looking value even when it isn't a suffix of the captured asset's URL — needed because a shared component like Avatar only ever gets ONE checkpoint, which may not correspond to any particular item (e.g. captured from Header, not from a session)", () => {
    const { document } = mergeDesignDocuments(dashboardWithThreeSessionCards(), [sessionCardDep()]);
    const { instanceOverrides, newAssets, warnings } = buildInstanceOverridesFromPerInstanceData(
      document.components.filter((c) => c.id === "comp_dashboard"),
      document.components,
      document.assets,
      { SessionCard: [{ learnerName: "Amir Hosseini", avatarSrc: "/avatars/totally-different-name.png" }] }
    );
    expect(warnings.some((w) => w.includes("avatarSrc"))).toBe(false);
    expect(instanceOverrides.node_session_0?.some((o) => o.fills)).toBe(true);
    // Even the reference item gets a new asset here, since the captured baseline (Amir's own
    // photo) doesn't literally equal this value — unlike the exact-match path.
    expect(newAssets.some((a) => a.path.endsWith("/avatars/totally-different-name.png"))).toBe(true);
  });

  it("stays unmatched (with a warning) when the value doesn't even look like an image path", () => {
    const { document } = mergeDesignDocuments(dashboardWithThreeSessionCards(), [sessionCardDep()]);
    const { instanceOverrides, warnings } = buildInstanceOverridesFromPerInstanceData(
      document.components.filter((c) => c.id === "comp_dashboard"),
      document.components,
      document.assets,
      { SessionCard: [{ learnerName: "Amir Hosseini", avatarSrc: "just-some-opaque-id" }] }
    );
    expect(warnings.some((w) => w.includes("avatarSrc"))).toBe(true);
    expect(instanceOverrides.node_session_0?.some((o) => o.fills)).not.toBe(true);
  });
});

describe("buildInstanceOverridesFromPerInstanceData — Avatar as its own shared nested-instance checkpoint, captured from an unrelated context (the exact real-run failure: SessionCard doesn't inline an image, it references a separately-captured Avatar component whose one checkpoint came from Header, not any session)", () => {
  const HEADER_CAPTURED_URL = "http://localhost:5173/avatars/current-user.png"; // Avatar@v001 was captured from Header, not a SessionCard

  function dashboardWithThreeSessionCards(): DesignDocument {
    return {
      $schema: "https://reactfig.dev/schema/design-ir/v1.json",
      version: "design-ir/v1",
      id: "dashboard-primary",
      name: "Dashboard",
      pages: [],
      assets: [],
      meta: { generator: "test", generatedAt: "2026-01-01T00:00:00Z" },
      components: [
        {
          kind: "component",
          id: "comp_dashboard",
          name: "Dashboard",
          root: {
            type: "frame",
            id: "node_dashboard_root",
            name: "Dashboard",
            bounds: { x: 0, y: 0, width: 800, height: 200 },
            children: [
              { type: "instance", id: "node_session_0", name: "SessionCard", bounds: { x: 0, y: 0, width: 200, height: 100 }, componentRef: { kind: "component", componentId: "external:SessionCard" } },
              { type: "instance", id: "node_session_1", name: "SessionCard", bounds: { x: 200, y: 0, width: 200, height: 100 }, componentRef: { kind: "component", componentId: "external:SessionCard" } },
              { type: "instance", id: "node_session_2", name: "SessionCard", bounds: { x: 400, y: 0, width: 200, height: 100 }, componentRef: { kind: "component", componentId: "external:SessionCard" } },
            ],
          },
        },
      ],
    };
  }

  // SessionCard's own capture doesn't inline an <img> — it references Avatar as a nested,
  // separately-captured component (`external:Avatar`), exactly like Dashboard references
  // SessionCard itself. This is the realistic shape generate_design_ir/the analyzer produce
  // for a composite component boundary (see ADR-0008's "Known limitations").
  function sessionCardDep(): DesignDocument {
    return {
      $schema: "https://reactfig.dev/schema/design-ir/v1.json",
      version: "design-ir/v1",
      id: "sessioncard-dep",
      name: "SessionCard",
      pages: [],
      assets: [],
      meta: { generator: "test", generatedAt: "2026-01-01T00:00:00Z" },
      components: [
        {
          kind: "component",
          id: "comp_session_card",
          name: "SessionCard",
          root: {
            type: "frame",
            id: "node_sessioncard_root",
            name: "SessionCard",
            bounds: { x: 0, y: 0, width: 200, height: 100 },
            children: [
              { type: "instance", id: "node_sessioncard_avatar_instance", name: "Avatar", bounds: { x: 0, y: 0, width: 48, height: 48 }, componentRef: { kind: "component", componentId: "external:Avatar" } },
              { type: "text", id: "node_sessioncard_name", name: "Name", bounds: { x: 0, y: 48, width: 200, height: 20 }, characters: "Amir Hosseini", typography: { fontFamily: "Inter", fontWeight: 700, fontSize: 14 } },
            ],
          },
        },
      ],
    };
  }

  // Avatar's own (only) checkpoint — captured once from Header's "current-user" avatar.
  function avatarDep(): DesignDocument {
    return {
      $schema: "https://reactfig.dev/schema/design-ir/v1.json",
      version: "design-ir/v1",
      id: "avatar-dep",
      name: "Avatar",
      pages: [],
      assets: [{ id: "asset_avatar_current_user", path: HEADER_CAPTURED_URL, mimeType: "image/png", width: 32, height: 32 }],
      meta: { generator: "test", generatedAt: "2026-01-01T00:00:00Z" },
      components: [
        {
          kind: "component",
          id: "comp_avatar",
          name: "Avatar",
          root: { type: "image", id: "node_avatar_image", name: "Avatar Image", bounds: { x: 0, y: 0, width: 32, height: 32 }, assetId: "asset_avatar_current_user" },
        },
      ],
    };
  }

  const perInstanceData = {
    SessionCard: [
      { learnerName: "Amir Hosseini", avatarSrc: "/avatars/amir.png" },
      { learnerName: "Sara Ahmadi", avatarSrc: "/avatars/sara.png" },
      { learnerName: "Dana Karimi", avatarSrc: "/avatars/dana.png" },
    ],
  };

  it("crosses into the nested Avatar instance to find its one image slot, and derives 3 distinct new photos from Avatar@v001's own origin — even though none of them match what was actually captured", () => {
    const { document } = mergeDesignDocuments(dashboardWithThreeSessionCards(), [sessionCardDep(), avatarDep()]);
    const primaryComponents = document.components.filter((c) => c.id === "comp_dashboard");

    const { instanceOverrides, newAssets, warnings } = buildInstanceOverridesFromPerInstanceData(primaryComponents, document.components, document.assets, perInstanceData);

    expect(warnings).toEqual([]); // avatarSrc now resolves via the image-slot fallback, not left unmatched

    // All 3 items get a NEW asset (even Amir's) since none literally match Header's captured photo.
    expect(newAssets).toHaveLength(3);
    const paths = newAssets.map((a) => a.path).sort();
    expect(paths).toEqual([
      "http://localhost:5173/avatars/amir.png",
      "http://localhost:5173/avatars/dana.png",
      "http://localhost:5173/avatars/sara.png",
    ]);

    const assetIdsByInstance = ["node_session_0", "node_session_1", "node_session_2"].map(
      (id) => instanceOverrides[id]?.find((o) => o.fills)?.fills?.[0]
    );
    const assetIds = assetIdsByInstance.map((f) => (f && "assetId" in f ? f.assetId : undefined));
    expect(assetIds.every((id) => typeof id === "string")).toBe(true);
    expect(new Set(assetIds).size).toBe(3); // three different photos — the actual bug fix
  });
});

describe("findNodePath — honors the specific variantId a `variant` instance ref points at (not always the ComponentSet's first variant)", () => {
  it("resolves against the secondary variant's own root when crossing into an instance referencing it, not primary's", () => {
    const sessionCard = loadFixture("session-card");
    const button = loadFixture("button");
    const sessionCardComp = sessionCard.components.find((c) => c.id === "comp_sessioncard") as ComponentDef;
    const root = sessionCardComp.root as Extract<Node, { type: "frame" }>;
    root.children.push({
      type: "instance",
      id: "node_button_secondary_ref",
      name: "Button",
      bounds: { x: 0, y: 0, width: 100, height: 40 },
      // Already resolved to the specific (non-first) variant — as a real
      // merged document's instance would be after rewriteExternalRefs,
      // or as any instance referencing a ComponentSet always is.
      componentRef: { kind: "variant", componentSetId: "comp_button", variantId: "comp_button_secondary_medium" },
    });

    const { document } = mergeDesignDocuments(sessionCard, [button]);

    // node_button_label_secondary only exists on the secondary variant's
    // root — resolving it against the set's first (primary) variant, as
    // the pre-fix code always did, would find nothing.
    const path = findNodePath(document, "comp_sessioncard", "dep0_node_button_label_secondary");
    expect(path).toEqual([2, 0]); // root.children[2] = the pushed Button instance -> its variant root's label (crossing costs no index) -> index 0

    // The label actually belonging to the *other* (primary) variant is
    // NOT reachable through this instance at all — proving the fix
    // isn't accidentally still matching whichever variant happens to be
    // first, but the one this specific instance really points at.
    const wrongVariantPath = findNodePath(document, "comp_sessioncard", "dep0_node_button_label");
    expect(wrongVariantPath).toBeNull();
  });
});
