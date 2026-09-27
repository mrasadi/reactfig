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
 * End-to-end regression test for Issue.md's reported Dashboard bugs,
 * against the ACTUAL merged Dashboard artifact (packages/mcp's
 * merge_design_ir_checkpoints, run with the instanceOverrides that fix
 * StatCard/SessionCard/Badge — Fix 2c), packed exactly like
 * export_design_artifact packs it and unpacked exactly like an import
 * would. This is the same real .rfd design/Dashboard_example.rfd was
 * regenerated from — not a synthetic fixture — so it proves the fix
 * against the real reported failure, not just an idealized reproduction.
 */
describe("Dashboard end-to-end — Issue.md Fix 2c (StatCard/SessionCard/Badge instance overrides)", () => {
  it("renders three StatCards with distinct value/label text — not three identical '12 / Sessions this week' cards", async () => {
    const unpacked = await unpack(fixtureBytes("dashboard-fixed.rfd"));
    const { figma, currentPage } = createFakeFigma();
    const result = await renderDocument(unpacked.document, unpacked.assets, unpacked.assetMimeTypes ?? {}, figma);
    // The one expected warning is unrelated to this fix: the fixture was
    // exported with fetchAssets:false, so the real Avatar photo isn't
    // embedded and falls back to a placeholder fill — nothing to do with
    // instance overrides, which is what this test actually verifies.
    expect(result.warnings).toEqual(['Component root "Reza": asset "dep4_asset_0" is not embedded in this artifact — using a placeholder.']);

    const importRoot = currentPage.children.find((c) => c.name.startsWith("ReactFig: "))!;
    // importRoot also holds every component MASTER definition (each
    // itself containing its own copy of whatever it instantiates) —
    // scope the search to just the actual rendered page content (the
    // "Dashboard" page instance) so this only counts what's really on
    // the canvas as page content, not every master's internal copy too.
    const pageInstance = (importRoot as unknown as { children: Array<{ type: string; name: string }> }).children.find((c) => c.type === "INSTANCE" && c.name === "Dashboard")!;
    const statCards = findAllByName(pageInstance as never, "StatCard");
    expect(statCards).toHaveLength(3);

    const values = statCards.map((sc) => [(sc.children[0] as { characters: string }).characters, (sc.children[1] as { characters: string }).characters]);
    expect(values).toEqual([
      ["12", "Sessions this week"],
      ["6.8", "Avg. speaking score"],
      ["1", "Missed sessions"],
    ]);
  });

  it("renders three SessionCards with distinct learner name/time and Badge status text+color — not three identical 'Amir Hosseini / completed' cards", async () => {
    const unpacked = await unpack(fixtureBytes("dashboard-fixed.rfd"));
    const { figma, currentPage } = createFakeFigma();
    const result = await renderDocument(unpacked.document, unpacked.assets, unpacked.assetMimeTypes ?? {}, figma);
    // The one expected warning is unrelated to this fix: the fixture was
    // exported with fetchAssets:false, so the real Avatar photo isn't
    // embedded and falls back to a placeholder fill — nothing to do with
    // instance overrides, which is what this test actually verifies.
    expect(result.warnings).toEqual(['Component root "Reza": asset "dep4_asset_0" is not embedded in this artifact — using a placeholder.']);

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
      return { name, time, badgeText, badgeFill: badge.fills };
    });

    expect(summarized[0]).toMatchObject({ name: "Amir Hosseini", time: "Today, 4:00 PM", badgeText: "completed" });
    expect(summarized[1]).toMatchObject({ name: "Sara Ahmadi", time: "Tomorrow, 10:00 AM", badgeText: "scheduled" });
    expect(summarized[2]).toMatchObject({ name: "Dana Karimi", time: "Yesterday, 2:00 PM", badgeText: "missed" });

    // The three Badges are no longer visually identical either — each
    // instance's badge fill was overridden to a distinct tone color.
    const fills = summarized.map((s) => JSON.stringify(s.badgeFill));
    expect(new Set(fills).size).toBe(3);
  });
});
