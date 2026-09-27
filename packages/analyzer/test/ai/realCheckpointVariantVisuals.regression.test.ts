import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildDesignIR } from "../../src/ai/buildDesignIR.js";
import type { ComponentEvidence } from "../../src/evidence/types.js";
import type { ComponentInterpretation } from "../../src/ai/types.js";

function fixture<T>(name: string): T {
  const path = fileURLToPath(new URL(`../fixtures/real-checkpoints/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

/**
 * Regression tests against REAL captured evidence (copied verbatim from
 * this repo's own `.reactfig/checkpoints/{SessionCard,StatCard}/v001/`,
 * produced by an actual live browser capture of the sample app, not a
 * synthetic fixture) — proving the two reported visual bugs are fixed at
 * the actual layer where the information was being lost (buildDesignIR's
 * nested-instance-boundary handling and mapBorder), using the exact
 * evidence shape `generate_design_ir` produces.
 */
describe("real-evidence regression — SessionCard Badge status visuals (Issue §9A)", () => {
  const evidence = fixture<ComponentEvidence>("session-card-evidence.json");
  const interpretation = fixture<ComponentInterpretation>("session-card-interpretation.json");
  const doc = buildDesignIR(evidence, interpretation);

  it("produces a SessionCard componentSet with one variant per status, as this evidence's capture-plan actually captured (3/3)", () => {
    const component = doc.components[0];
    expect(component.kind).toBe("componentSet");
    if (component.kind !== "componentSet") return;
    expect(component.variants).toHaveLength(3);
    expect(component.variants.map((v) => v.propertyValues.status).sort()).toEqual(["completed", "missed", "scheduled"]);
  });

  it("gives each status variant's nested Badge instance a DISTINCT fill/text override matching that variant's actually-observed badge color and status text — not the same badge on all three", () => {
    const component = doc.components[0];
    if (component.kind !== "componentSet") throw new Error("expected componentSet");

    function findBadgeInstance(node: (typeof component.variants)[number]["root"]): Extract<typeof node, { type: "instance" }> {
      if (node.type === "instance" && node.componentRef.kind === "component" && node.componentRef.componentId === "external:Badge") return node;
      if ("children" in node) {
        for (const child of node.children) {
          const found = tryFind(child);
          if (found) return found;
        }
      }
      throw new Error("Badge instance not found");
      function tryFind(n: typeof node): Extract<typeof node, { type: "instance" }> | null {
        if (n.type === "instance" && n.componentRef.kind === "component" && n.componentRef.componentId === "external:Badge") return n;
        if ("children" in n) {
          for (const child of n.children) {
            const r = tryFind(child);
            if (r) return r;
          }
        }
        return null;
      }
    }

    const byStatus = new Map(component.variants.map((v) => [v.propertyValues.status, findBadgeInstance(v.root)]));
    expect([...byStatus.keys()].sort()).toEqual(["completed", "missed", "scheduled"]);

    const summarized = [...byStatus.entries()].map(([status, badge]) => ({
      status,
      text: badge.overrides?.find((o) => o.path.length === 1)?.characters,
      fill: JSON.stringify(badge.overrides?.find((o) => o.path.length === 0)?.fills),
    }));

    // Text override matches the status itself (real reported app text: the
    // badge's own textContent IS the status word).
    for (const s of summarized) expect(s.text).toBe(s.status);

    // The actual bug: all three fills must be genuinely distinct — not the
    // same default color reused because the boundary-crossing branch
    // discarded per-instance evidence.
    expect(new Set(summarized.map((s) => s.fill)).size).toBe(3);
    for (const s of summarized) expect(s.fill).toBeDefined();
  });
});

describe("real-evidence regression — StatCard tone border (Issue §9B)", () => {
  const evidence = fixture<ComponentEvidence>("stat-card-evidence.json");
  const interpretation = fixture<ComponentInterpretation>("stat-card-interpretation.json");
  const doc = buildDesignIR(evidence, interpretation);

  it("produces a StatCard componentSet with one variant per tone, as this evidence's capture-plan actually captured (3/3)", () => {
    const component = doc.components[0];
    expect(component.kind).toBe("componentSet");
    if (component.kind !== "componentSet") return;
    expect(component.variants).toHaveLength(3);
    expect(component.variants.map((v) => v.propertyValues.tone).sort()).toEqual(["neutral", "success", "warning"]);
  });

  it("gives each tone variant a DISTINCT left-accent stroke color matching that tone's actually-observed border — not the same shared neutral-gray border on all three (the reported bug: mapBorder previously always picked the first/top side, which is identical across every tone)", () => {
    const component = doc.components[0];
    if (component.kind !== "componentSet") throw new Error("expected componentSet");

    const byTone = new Map(
      component.variants.map((v) => {
        if (v.root.type !== "frame") throw new Error("expected frame root");
        return [v.propertyValues.tone, v.root.strokes?.[0]?.color] as const;
      })
    );
    expect([...byTone.keys()].sort()).toEqual(["neutral", "success", "warning"]);

    const colors = [...byTone.values()].map((c) => JSON.stringify(c));
    for (const c of colors) expect(c).toBeDefined();
    expect(new Set(colors).size).toBe(3);

    // And each is the real captured left-accent color from evidence.json,
    // not some other side's color: neutral=gray, success=green, warning=orange/brown.
    expect(byTone.get("success")!.g).toBeGreaterThan(byTone.get("success")!.r); // green-dominant
    expect(byTone.get("warning")!.r).toBeGreaterThan(byTone.get("warning")!.g); // orange/brown-dominant
  });
});
