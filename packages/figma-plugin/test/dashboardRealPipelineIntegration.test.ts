import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unpack } from "@reactfig/artifact";
import type { FakeNode } from "./fakeFigma/createFakeFigma.js";
import { renderDocument } from "../src/code/render/renderDocument.js";
import { createFakeFigma } from "./fakeFigma/createFakeFigma.js";

function fixtureBytes(name: string): Uint8Array {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return new Uint8Array(readFileSync(path));
}

function findAllByName(node: { name: string; children?: unknown[] }, name: string, out: Array<{ name: string; children: unknown[] }> = []): Array<{ name: string; children: unknown[] }> {
  if (node.name === name) out.push(node as never);
  for (const child of node.children ?? []) findAllByName(child as never, name, out);
  return out;
}

/**
 * End-to-end regression test against a .rfd produced by the REAL, current
 * pipeline — `merge_design_ir_checkpoints` run in-process against this
 * repo's own real `.reactfig/checkpoints/{Dashboard,StatCard,SessionCard,
 * Avatar,Badge,Button,Header,Sidebar}` (StatCard's and SessionCard's
 * design-ir.json regenerated from their own real, unmodified
 * evidence.json/interpretation.json using the fixed buildDesignIR, then
 * merged with ONLY `perInstanceData` — the exact shape
 * `inspect_component_dependency_tree`'s auto-discovery produces, taken
 * verbatim from examples/sample-react-app/src/screens/Dashboard.tsx's own
 * STATS/SESSIONS arrays), then exported and re-packed exactly like
 * `export_design_artifact` does.
 *
 * Unlike `dashboardOverridesIntegration.test.ts`'s `dashboard-fixed.rfd`
 * (a fixture built with hand-supplied `instanceOverrides` for the Badge
 * fills specifically), this fixture required NO manual instanceOverrides
 * at all — every override and every variant selection here was derived
 * automatically. This is what actually proves Issue.md §9's two bugs are
 * fixed end-to-end, not just at the unit level.
 */
describe("Dashboard end-to-end, real pipeline — SessionCard Badge status + StatCard tone border (Issue.md §9A/§9B)", () => {
  it("StatCard: three distinct variants (tone-correct border) with correct text — not the same 'neutral' variant/border on all three", async () => {
    const unpacked = await unpack(fixtureBytes("dashboard-real-pipeline.rfd"));
    const { figma, currentPage } = createFakeFigma();
    const result = await renderDocument(unpacked.document, unpacked.assets, unpacked.assetMimeTypes ?? {}, figma);
    expect(result.warnings).toEqual([
      'Component root "avatar-image": asset "dep4_asset_0" is not embedded in this artifact — using a placeholder.',
      'Instance "SessionCard" override target: asset "asset_session_card_avatar_src_0" is not embedded in this artifact — using a placeholder.',
      'Instance "SessionCard" override target: asset "asset_session_card_avatar_src_1" is not embedded in this artifact — using a placeholder.',
      'Instance "SessionCard" override target: asset "asset_session_card_avatar_src_2" is not embedded in this artifact — using a placeholder.',
    ]); // unrelated to this test — the fixture was exported with fetchAssets:false, so avatar photos fall back to placeholders

    const importRoot = currentPage.children.find((c) => c.name.startsWith("ReactFig: "))!;
    const pageInstance = (importRoot as unknown as { children: Array<{ type: string; name: string }> }).children.find((c) => c.type === "INSTANCE" && c.name === "Dashboard")!;
    const statCards = findAllByName(pageInstance as never, "StatCard") as unknown as FakeNode[];
    expect(statCards).toHaveLength(3);

    const summarized = statCards.map((sc) => ({
      value: (sc.children[0] as unknown as { characters: string }).characters,
      label: (sc.children[1] as unknown as { characters: string }).characters,
      stroke: JSON.stringify((sc as unknown as { strokes?: unknown }).strokes),
    }));
    expect(summarized.map((s) => [s.value, s.label])).toEqual([
      ["12", "Sessions this week"],
      ["6.8", "Avg. speaking score"],
      ["1", "Missed sessions"],
    ]);

    // The actual reported bug: all three StatCard borders must be
    // genuinely distinct (neutral/success/warning), not the same shared
    // stroke reused on every card.
    expect(new Set(summarized.map((s) => s.stroke)).size).toBe(3);
  });

  it("SessionCard: three distinct learners with correct Badge status text AND color — not three identical 'completed'-colored badges", async () => {
    const unpacked = await unpack(fixtureBytes("dashboard-real-pipeline.rfd"));
    const { figma, currentPage } = createFakeFigma();
    const result = await renderDocument(unpacked.document, unpacked.assets, unpacked.assetMimeTypes ?? {}, figma);
    expect(result.warnings).toEqual([
      'Component root "avatar-image": asset "dep4_asset_0" is not embedded in this artifact — using a placeholder.',
      'Instance "SessionCard" override target: asset "asset_session_card_avatar_src_0" is not embedded in this artifact — using a placeholder.',
      'Instance "SessionCard" override target: asset "asset_session_card_avatar_src_1" is not embedded in this artifact — using a placeholder.',
      'Instance "SessionCard" override target: asset "asset_session_card_avatar_src_2" is not embedded in this artifact — using a placeholder.',
    ]); // unrelated to this test — the fixture was exported with fetchAssets:false, so avatar photos fall back to placeholders

    const importRoot = currentPage.children.find((c) => c.name.startsWith("ReactFig: "))!;
    const pageInstance = (importRoot as unknown as { children: Array<{ type: string; name: string }> }).children.find((c) => c.type === "INSTANCE" && c.name === "Dashboard")!;
    const sessionCards = findAllByName(pageInstance as never, "SessionCard") as unknown as FakeNode[];
    expect(sessionCards).toHaveLength(3);

    const summarized = sessionCards.map((card) => {
      const cardBody = card.children[0];
      const row = cardBody.children[0];
      const info = row.children[1];
      const name = (info.children[0] as unknown as { characters: string }).characters;
      const time = (info.children[1] as unknown as { characters: string }).characters;
      const badge = info.children[2];
      const badgeText = (badge.children[0] as unknown as { characters: string }).characters;
      return { name, time, badgeText, badgeFill: JSON.stringify(badge.fills) };
    });

    expect(summarized[0]).toMatchObject({ name: "Amir Hosseini", time: "Today, 4:00 PM", badgeText: "completed" });
    expect(summarized[1]).toMatchObject({ name: "Sara Ahmadi", time: "Tomorrow, 10:00 AM", badgeText: "scheduled" });
    expect(summarized[2]).toMatchObject({ name: "Dana Karimi", time: "Yesterday, 2:00 PM", badgeText: "missed" });

    // Every Badge fill must be distinct — the real reported bug ("all
    // SessionCard Badges currently look the same").
    expect(new Set(summarized.map((s) => s.badgeFill)).size).toBe(3);
  });
});
