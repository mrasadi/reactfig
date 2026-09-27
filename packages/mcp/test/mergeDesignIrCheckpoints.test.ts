import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unpack } from "@reactfig/artifact";
import { connectedClient, loadFixture, textOf } from "./support/mcpTestClient.js";
import { openVersionedCheckpointDir, writeCheckpoint } from "../src/checkpoint.js";
import type { ComponentDef, DesignDocument, Node } from "@reactfig/core";

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

/** Seeds `<projectRoot>/.reactfig/checkpoints/<id>/design-ir.json`, mirroring what generate_design_ir already leaves on disk. */
async function seedCheckpoint(projectRoot: string, id: string, document: DesignDocument): Promise<void> {
  const dir = await openVersionedCheckpointDir(projectRoot, id);
  await writeCheckpoint(dir, "designIr", document);
}

/** Like seedCheckpoint, but also writes a capture-plan.json with the given selector — needed for findDivergentSiblingVersions (checkpoint.ts) to have something to compare across versions. Each call allocates the NEXT version for `id`, exactly like two separate generate_design_ir calls would. */
async function seedCheckpointVersionWithPlan(projectRoot: string, id: string, document: DesignDocument, selector: string): Promise<void> {
  const dir = await openVersionedCheckpointDir(projectRoot, id);
  await writeCheckpoint(dir, "designIr", document);
  await writeCheckpoint(dir, "capturePlan", {
    revisionKey: "rev",
    captures: [{ id: "cap_1", label: "default", url: "http://localhost:5174", selector, viewport: { width: 1440, height: 900 }, status: "completed" }],
  });
}

/** A minimal, standalone Badge document — the session-card fixture's external:Badge ref resolves against a component id of `comp_badge`, which the shared avatar/button fixtures don't provide. */
function badgeDocument(): DesignDocument {
  return {
    $schema: "https://reactfig.dev/schema/design-ir/v1.json",
    version: "design-ir/v1",
    id: "doc_badge",
    name: "Badge example",
    meta: { generator: "@reactfig/analyzer ai-orchestration@0.1.0", generatedAt: "2026-08-19T12:00:00.000Z" },
    assets: [],
    components: [
      {
        kind: "component",
        id: "comp_badge",
        name: "Badge",
        source: { file: "src/components/Badge.tsx", export: "Badge" },
        root: {
          type: "text",
          id: "node_badge_text",
          name: "Badge Text",
          bounds: { x: 0, y: 0, width: 60, height: 20 },
          characters: "completed",
          typography: { fontFamily: "Inter", fontWeight: 700, fontSize: 12, textAlign: "center" },
        },
      },
    ],
    pages: [
      {
        id: "page_examples",
        name: "Examples",
        children: [
          {
            type: "instance",
            id: "node_badge_instance",
            name: "Badge",
            bounds: { x: 0, y: 0, width: 60, height: 20 },
            componentRef: { kind: "component", componentId: "comp_badge" },
          },
        ],
      },
    ],
  } as DesignDocument;
}

let tmpDir: string;
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("MCP dispatch boundary — merge_design_ir_checkpoints", () => {
  it("merges primary + dependency checkpoints by id, persists a merged checkpoint, and exports a working .rfd in one call", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-merge-checkpoints-"));
    await seedCheckpoint(tmpDir, "SessionCard", loadFixture("session-card"));
    await seedCheckpoint(tmpDir, "Avatar", loadFixture("avatar"));

    const client = await connectedClient();
    const mergeResult = await client.callTool({
      name: "merge_design_ir_checkpoints",
      arguments: {
        primaryCheckpointId: "SessionCard",
        dependencyCheckpointIds: ["Avatar"],
        outputPath: "SessionCard.rfd",
        fetchAssets: false,
        projectRoot: tmpDir,
      },
    });
    expect(mergeResult.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(mergeResult));

    expect(parsed.unresolvedExternalRefs).toEqual(["external:Badge"]);
    expect(existsSync(join(parsed.mergedCheckpoint.path, "design-ir.json"))).toBe(true);
    expect(parsed.artifact.path).toBe(join(tmpDir, "SessionCard.rfd"));

    const bytes = new Uint8Array(readFileSync(parsed.artifact.path));
    const unpacked = await unpack(bytes);
    const sessionCardComp = unpacked.document.components.find((c) => c.id === "comp_sessioncard")! as ComponentDef;
    const avatarInstance = findInstance(sessionCardComp.root, "Avatar")!;
    expect(avatarInstance.componentRef).toEqual({ kind: "component", componentId: "comp_avatar" });
  });

  it("defaults mergedCheckpointId to merged-<primaryCheckpointId> and skips export when exportArtifact is false", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-merge-checkpoints-"));
    await seedCheckpoint(tmpDir, "SessionCard", loadFixture("session-card"));
    await seedCheckpoint(tmpDir, "Avatar", loadFixture("avatar"));

    const client = await connectedClient();
    const mergeResult = await client.callTool({
      name: "merge_design_ir_checkpoints",
      arguments: {
        primaryCheckpointId: "SessionCard",
        dependencyCheckpointIds: ["Avatar"],
        exportArtifact: false,
        projectRoot: tmpDir,
      },
    });
    expect(mergeResult.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(mergeResult));

    expect(parsed.mergedCheckpoint.id).toBe("merged-SessionCard");
    expect(parsed.mergedCheckpoint.version).toBe(1);
    expect(parsed.mergedCheckpoint.checkpointRef).toBe("merged-SessionCard@v001");
    expect(existsSync(join(tmpDir, ".reactfig", "checkpoints", "merged-SessionCard", "v001", "design-ir.json"))).toBe(true);
    expect(parsed.artifact).toBeNull();
  });

  it("reports a clear error (not a raw crash) when a checkpoint id doesn't exist on disk", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-merge-checkpoints-"));
    await seedCheckpoint(tmpDir, "SessionCard", loadFixture("session-card"));

    const client = await connectedClient();
    const mergeResult = await client.callTool({
      name: "merge_design_ir_checkpoints",
      arguments: {
        primaryCheckpointId: "SessionCard",
        dependencyCheckpointIds: ["NoSuchCheckpoint"],
        projectRoot: tmpDir,
      },
    });

    expect(mergeResult.isError).toBe(true);
    const content = mergeResult.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toMatch(/no checkpoints found for component/);
  });

  it("resolves a componentSet dependency (Button) to a variant ref via checkpoints, same as merge_design_ir_documents", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-merge-checkpoints-"));
    const sessionCard = loadFixture("session-card");
    const sessionCardComp = sessionCard.components.find((c) => c.id === "comp_sessioncard") as ComponentDef;
    (sessionCardComp.root as Extract<Node, { type: "frame" }>).children.push({
      type: "instance",
      id: "node_button_ref",
      name: "Button",
      bounds: { x: 0, y: 0, width: 100, height: 40 },
      componentRef: { kind: "component", componentId: "external:Button" },
    });
    await seedCheckpoint(tmpDir, "SessionCard", sessionCard);
    await seedCheckpoint(tmpDir, "Button", loadFixture("button"));

    const client = await connectedClient();
    const mergeResult = await client.callTool({
      name: "merge_design_ir_checkpoints",
      arguments: {
        primaryCheckpointId: "SessionCard",
        dependencyCheckpointIds: ["Button"],
        outputPath: "SessionCard.rfd",
        fetchAssets: false,
        projectRoot: tmpDir,
      },
    });
    expect(mergeResult.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(mergeResult));
    expect(parsed.duplicateComponentIds).toEqual([]);

    const bytes = new Uint8Array(readFileSync(parsed.artifact.path));
    const unpacked = await unpack(bytes);
    const unpackedSessionCardComp = unpacked.document.components.find((c) => c.id === "comp_sessioncard")! as ComponentDef;
    const unpackedButtonInstance = findInstance(unpackedSessionCardComp.root, "Button")!;
    expect(unpackedButtonInstance.componentRef).toEqual({ kind: "variant", componentSetId: "comp_button", variantId: "comp_button_primary_large" });
  });

  it("resolves an explicit '@vN' checkpoint reference for a dependency, not just the latest version", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-merge-checkpoints-"));
    await seedCheckpoint(tmpDir, "SessionCard", loadFixture("session-card"));
    // Two Avatar generations — v1 first, v2 second (the seed helper always
    // allocates the next free version for the same component name).
    await seedCheckpoint(tmpDir, "Avatar", loadFixture("avatar"));
    await seedCheckpoint(tmpDir, "Avatar", loadFixture("avatar"));

    const client = await connectedClient();
    const mergeResult = await client.callTool({
      name: "merge_design_ir_checkpoints",
      arguments: {
        primaryCheckpointId: "SessionCard",
        dependencyCheckpointIds: ["Avatar@v1"],
        exportArtifact: false,
        projectRoot: tmpDir,
      },
    });
    expect(mergeResult.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(mergeResult));
    expect(parsed.unresolvedExternalRefs).toEqual(["external:Badge"]);
  });

  it("auto-resolves unresolved external refs against existing checkpoints without them being passed in dependencyCheckpointIds", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-merge-checkpoints-"));
    await seedCheckpoint(tmpDir, "SessionCard", loadFixture("session-card"));
    await seedCheckpoint(tmpDir, "Avatar", loadFixture("avatar"));
    // Badge checkpoint already exists on disk (e.g. from an earlier pass)
    // but is deliberately NOT listed in dependencyCheckpointIds below.
    await seedCheckpoint(tmpDir, "Badge", badgeDocument());

    const client = await connectedClient();
    const mergeResult = await client.callTool({
      name: "merge_design_ir_checkpoints",
      arguments: {
        primaryCheckpointId: "SessionCard",
        dependencyCheckpointIds: ["Avatar"],
        exportArtifact: false,
        projectRoot: tmpDir,
      },
    });
    expect(mergeResult.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(mergeResult));

    // Badge is discovered and folded in automatically -> no longer unresolved.
    expect(parsed.unresolvedExternalRefs).toEqual([]);
    expect(parsed.autoResolvedCheckpoints).toEqual(["Badge@v001"]);
  });

  it("applies instanceOverrides to the resulting checkpoint's merged document — the mechanism that fixes Issue.md's 'every SessionCard/StatCard instance renders identical content' bug (Fix 2c)", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-merge-checkpoints-"));
    await seedCheckpoint(tmpDir, "SessionCard", loadFixture("session-card"));
    await seedCheckpoint(tmpDir, "Avatar", loadFixture("avatar"));
    await seedCheckpoint(tmpDir, "Badge", badgeDocument());

    const client = await connectedClient();
    const mergeResult = await client.callTool({
      name: "merge_design_ir_checkpoints",
      arguments: {
        primaryCheckpointId: "SessionCard",
        dependencyCheckpointIds: ["Avatar", "Badge"],
        exportArtifact: false,
        projectRoot: tmpDir,
        // node_badge_instance's own root (comp_badge, resolved from
        // external:Badge) is a bare text node "completed" — path: []
        // targets that root directly, same as the Avatar image case.
        instanceOverrides: { node_badge_instance: [{ path: [], characters: "scheduled" }] },
      },
    });
    expect(mergeResult.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(mergeResult));

    const merged = await client.callTool({
      name: "validate_design_ir",
      arguments: { document: JSON.parse(readFileSync(parsed.mergedCheckpoint.designIrPath, "utf-8")) },
    });
    expect(merged.isError).not.toBe(true);

    const document = JSON.parse(readFileSync(parsed.mergedCheckpoint.designIrPath, "utf-8"));
    const sessionCardComp = document.components.find((c: ComponentDef) => c.id === "comp_sessioncard");
    const badgeInstance = findInstance(sessionCardComp.root, "Badge")!;
    expect(badgeInstance.overrides).toEqual([{ path: [], characters: "scheduled" }]);
  });

  it("does not auto-resolve when reuseExistingCheckpoints is explicitly false", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-merge-checkpoints-"));
    await seedCheckpoint(tmpDir, "SessionCard", loadFixture("session-card"));
    await seedCheckpoint(tmpDir, "Avatar", loadFixture("avatar"));
    await seedCheckpoint(tmpDir, "Badge", badgeDocument());

    const client = await connectedClient();
    const mergeResult = await client.callTool({
      name: "merge_design_ir_checkpoints",
      arguments: {
        primaryCheckpointId: "SessionCard",
        dependencyCheckpointIds: ["Avatar"],
        exportArtifact: false,
        reuseExistingCheckpoints: false,
        projectRoot: tmpDir,
      },
    });
    expect(mergeResult.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(mergeResult));

    expect(parsed.unresolvedExternalRefs).toEqual(["external:Badge"]);
    expect(parsed.autoResolvedCheckpoints).toEqual([]);
  });

  it("re-merging the same primary allocates a new merged checkpoint version rather than overwriting the previous one", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-merge-checkpoints-"));
    await seedCheckpoint(tmpDir, "SessionCard", loadFixture("session-card"));
    await seedCheckpoint(tmpDir, "Avatar", loadFixture("avatar"));

    const client = await connectedClient();
    const args = {
      primaryCheckpointId: "SessionCard",
      dependencyCheckpointIds: ["Avatar"],
      exportArtifact: false,
      projectRoot: tmpDir,
    };
    const first = JSON.parse(textOf(await client.callTool({ name: "merge_design_ir_checkpoints", arguments: args })));
    const second = JSON.parse(textOf(await client.callTool({ name: "merge_design_ir_checkpoints", arguments: args })));

    expect(first.mergedCheckpoint.version).toBe(1);
    expect(second.mergedCheckpoint.version).toBe(2);
    expect(existsSync(join(first.mergedCheckpoint.path, "design-ir.json"))).toBe(true);
    expect(existsSync(join(second.mergedCheckpoint.path, "design-ir.json"))).toBe(true);
  });

  it("perInstanceData — derives instanceOverrides automatically for 3 StatCards, without the caller hand-building InstanceOverride paths (the exact translation a real run previously got wrong)", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-merge-checkpoints-"));

    const dashboard: DesignDocument = {
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

    const statCard: DesignDocument = {
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

    await seedCheckpoint(tmpDir, "Dashboard", dashboard);
    await seedCheckpoint(tmpDir, "StatCard", statCard);

    const client = await connectedClient();
    const mergeResult = await client.callTool({
      name: "merge_design_ir_checkpoints",
      arguments: {
        primaryCheckpointId: "Dashboard",
        dependencyCheckpointIds: ["StatCard"],
        exportArtifact: false,
        projectRoot: tmpDir,
        perInstanceData: {
          StatCard: [
            { label: "Sessions this week", value: "12", tone: "neutral" },
            { label: "Avg. speaking score", value: "6.8", tone: "success" },
            { label: "Missed sessions", value: "1", tone: "warning" },
          ],
        },
      },
    });
    expect(mergeResult.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(mergeResult));

    // "tone" is never its own captured text node — expected, and reported, not a failure.
    expect(parsed.instanceOverrideWarnings).toEqual([
      'buildInstanceOverridesFromPerInstanceData: "StatCard" — could not find a captured text node or image asset matching field(s) tone (checked against the first item\'s values, and — for image-path-looking values — against the component\'s own unclaimed image slots); these fields won\'t be overridden on any instance.',
    ]);

    const document = JSON.parse(readFileSync(parsed.mergedCheckpoint.designIrPath, "utf-8"));
    const dashboardComp = document.components.find((c: ComponentDef) => c.id === "comp_dashboard");
    const statCards = (dashboardComp.root as { children: Array<{ id: string; overrides?: Array<{ characters?: string }> }> }).children;

    const values = statCards.map((sc) => sc.overrides?.map((o) => o.characters).sort());
    expect(values).toEqual([
      ["12", "Sessions this week"],
      ["6.8", "Avg. speaking score"],
      ["1", "Missed sessions"],
    ]);
  });

  it("perInstanceData — explicit instanceOverrides for the same instance are applied on top of, not instead of, the derived ones", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-merge-checkpoints-"));

    const dashboard: DesignDocument = {
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
            bounds: { x: 0, y: 0, width: 800, height: 100 },
            children: [{ type: "instance", id: "node_stat_0", name: "StatCard", bounds: { x: 0, y: 0, width: 200, height: 100 }, componentRef: { kind: "component", componentId: "external:StatCard" } }],
          },
        },
      ],
    };

    const statCard: DesignDocument = {
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
            bounds: { x: 0, y: 0, width: 200, height: 40 },
            children: [{ type: "text", id: "node_statcard_value", name: "Value", bounds: { x: 0, y: 0, width: 200, height: 40 }, characters: "12", typography: { fontFamily: "Inter", fontWeight: 700, fontSize: 24 } }],
          },
        },
      ],
    };

    await seedCheckpoint(tmpDir, "Dashboard", dashboard);
    await seedCheckpoint(tmpDir, "StatCard", statCard);

    const client = await connectedClient();
    const mergeResult = await client.callTool({
      name: "merge_design_ir_checkpoints",
      arguments: {
        primaryCheckpointId: "Dashboard",
        dependencyCheckpointIds: ["StatCard"],
        exportArtifact: false,
        projectRoot: tmpDir,
        perInstanceData: { StatCard: [{ value: "12" }] },
        // Explicit override on the same node/path — should win over the derived "12".
        instanceOverrides: { node_stat_0: [{ path: [0], characters: "99" }] },
      },
    });
    expect(mergeResult.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(mergeResult));

    const document = JSON.parse(readFileSync(parsed.mergedCheckpoint.designIrPath, "utf-8"));
    const dashboardComp = document.components.find((c: ComponentDef) => c.id === "comp_dashboard");
    const statCardInstance = (dashboardComp.root as { children: Array<{ id: string; overrides?: Array<{ path: number[]; characters?: string }> }> }).children[0];

    expect(statCardInstance.overrides).toEqual([
      { path: [0], characters: "12" },
      { path: [0], characters: "99" },
    ]);
  });

  it("perInstanceData — avatarSrc (an image field, not text) derives a distinct asset per SessionCard instance instead of going unmatched (Issue.md real-run follow-up: every SessionCard was still showing the same photo)", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-merge-checkpoints-"));

    const CAPTURED_AVATAR_URL = "http://localhost:5173/avatars/amir.png";

    const dashboard: DesignDocument = {
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
            bounds: { x: 0, y: 0, width: 800, height: 100 },
            children: [
              { type: "instance", id: "node_session_0", name: "SessionCard", bounds: { x: 0, y: 0, width: 200, height: 100 }, componentRef: { kind: "component", componentId: "external:SessionCard" } },
              { type: "instance", id: "node_session_1", name: "SessionCard", bounds: { x: 200, y: 0, width: 200, height: 100 }, componentRef: { kind: "component", componentId: "external:SessionCard" } },
              { type: "instance", id: "node_session_2", name: "SessionCard", bounds: { x: 400, y: 0, width: 200, height: 100 }, componentRef: { kind: "component", componentId: "external:SessionCard" } },
            ],
          },
        },
      ],
    };

    const sessionCard: DesignDocument = {
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
            children: [{ type: "image", id: "node_sessioncard_avatar", name: "Avatar", bounds: { x: 0, y: 0, width: 48, height: 48 }, assetId: "asset_avatar_amir" }],
          },
        },
      ],
    };

    await seedCheckpoint(tmpDir, "Dashboard", dashboard);
    await seedCheckpoint(tmpDir, "SessionCard", sessionCard);

    const client = await connectedClient();
    const mergeResult = await client.callTool({
      name: "merge_design_ir_checkpoints",
      arguments: {
        primaryCheckpointId: "Dashboard",
        dependencyCheckpointIds: ["SessionCard"],
        exportArtifact: false,
        projectRoot: tmpDir,
        perInstanceData: {
          SessionCard: [{ avatarSrc: "/avatars/amir.png" }, { avatarSrc: "/avatars/sara.png" }, { avatarSrc: "/avatars/dana.png" }],
        },
      },
    });
    expect(mergeResult.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(mergeResult));
    expect(parsed.instanceOverrideWarnings).toEqual([]);

    const document = JSON.parse(readFileSync(parsed.mergedCheckpoint.designIrPath, "utf-8"));

    // New assets for Sara and Dana were appended to the merged document.
    const assetPaths: string[] = document.assets.map((a: { path: string }) => a.path);
    expect(assetPaths).toEqual(
      expect.arrayContaining(["http://localhost:5173/avatars/sara.png", "http://localhost:5173/avatars/dana.png"])
    );

    const dashboardComp = document.components.find((c: ComponentDef) => c.id === "comp_dashboard");
    const sessionInstances = (dashboardComp.root as { children: Array<{ overrides?: Array<{ fills?: Array<{ assetId: string }> }> }> }).children;
    const assetIds = sessionInstances.map((n) => n.overrides?.find((o) => o.fills)?.fills?.[0]?.assetId);

    expect(assetIds.every((id) => typeof id === "string")).toBe(true);
    expect(new Set(assetIds).size).toBe(3); // three distinct photos, not the same one repeated
    // Every referenced assetId is actually present in document.assets (not a dangling reference).
    const knownAssetIds = new Set(document.assets.map((a: { id: string }) => a.id));
    for (const id of assetIds) expect(knownAssetIds.has(id)).toBe(true);
  });

  it("perInstanceData — the exact real-run scenario: Avatar is its own separately-captured nested component, whose one checkpoint was captured from Header (not from any SessionCard) — still derives 3 distinct photos via the image-slot fallback", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-merge-checkpoints-"));

    const HEADER_CAPTURED_URL = "http://localhost:5173/avatars/current-user.png";

    const dashboard: DesignDocument = {
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
            bounds: { x: 0, y: 0, width: 800, height: 100 },
            children: [
              { type: "instance", id: "node_session_0", name: "SessionCard", bounds: { x: 0, y: 0, width: 200, height: 100 }, componentRef: { kind: "component", componentId: "external:SessionCard" } },
              { type: "instance", id: "node_session_1", name: "SessionCard", bounds: { x: 200, y: 0, width: 200, height: 100 }, componentRef: { kind: "component", componentId: "external:SessionCard" } },
              { type: "instance", id: "node_session_2", name: "SessionCard", bounds: { x: 400, y: 0, width: 200, height: 100 }, componentRef: { kind: "component", componentId: "external:SessionCard" } },
            ],
          },
        },
      ],
    };

    const sessionCard: DesignDocument = {
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
            children: [{ type: "instance", id: "node_sessioncard_avatar_instance", name: "Avatar", bounds: { x: 0, y: 0, width: 48, height: 48 }, componentRef: { kind: "component", componentId: "external:Avatar" } }],
          },
        },
      ],
    };

    const avatar: DesignDocument = {
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

    await seedCheckpoint(tmpDir, "Dashboard", dashboard);
    await seedCheckpoint(tmpDir, "SessionCard", sessionCard);
    await seedCheckpoint(tmpDir, "Avatar", avatar);

    const client = await connectedClient();
    const mergeResult = await client.callTool({
      name: "merge_design_ir_checkpoints",
      arguments: {
        primaryCheckpointId: "Dashboard",
        dependencyCheckpointIds: ["SessionCard", "Avatar"],
        exportArtifact: false,
        projectRoot: tmpDir,
        perInstanceData: {
          SessionCard: [{ avatarSrc: "/avatars/amir.png" }, { avatarSrc: "/avatars/sara.png" }, { avatarSrc: "/avatars/dana.png" }],
        },
      },
    });
    expect(mergeResult.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(mergeResult));
    expect(parsed.instanceOverrideWarnings).toEqual([]); // no longer left unmatched

    const document = JSON.parse(readFileSync(parsed.mergedCheckpoint.designIrPath, "utf-8"));
    const assetPaths: string[] = document.assets.map((a: { path: string }) => a.path);
    expect(assetPaths).toEqual(
      expect.arrayContaining(["http://localhost:5173/avatars/amir.png", "http://localhost:5173/avatars/sara.png", "http://localhost:5173/avatars/dana.png"])
    );

    const dashboardComp = document.components.find((c: ComponentDef) => c.id === "comp_dashboard");
    const sessionInstances = (dashboardComp.root as { children: Array<{ overrides?: Array<{ fills?: Array<{ assetId: string }> }> }> }).children;
    const assetIds = sessionInstances.map((n) => n.overrides?.find((o) => o.fills)?.fills?.[0]?.assetId);
    expect(assetIds.every((id) => typeof id === "string")).toBe(true);
    expect(new Set(assetIds).size).toBe(3);
  });
});



describe("MCP dispatch boundary — merge_design_ir_checkpoints surfaces staleCheckpointVersionWarnings (docs/adr/0024-divergent-checkpoint-version-detection.md)", () => {
  it("flags a dependency (Avatar) that resolved to a single-version checkpoint while an earlier, differently-captured version also exists on disk — the real StatCard/SessionCard bug's exact signature, reproduced with a smaller fixture", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-merge-checkpoints-"));
    await seedCheckpoint(tmpDir, "SessionCard", loadFixture("session-card"));

    // Two SEPARATE "generate_design_ir" calls for Avatar, each targeting a
    // different on-page position directly instead of one call with a
    // `variants` argument — exactly the real bug's reproduction.
    const avatarDoc = loadFixture("avatar") as DesignDocument;
    await seedCheckpointVersionWithPlan(tmpDir, "Avatar", avatarDoc, "#root .session-card:nth-of-type(1) img");
    await seedCheckpointVersionWithPlan(tmpDir, "Avatar", avatarDoc, "#root .session-card:nth-of-type(2) img");

    const client = await connectedClient();
    const mergeResult = await client.callTool({
      name: "merge_design_ir_checkpoints",
      arguments: {
        primaryCheckpointId: "SessionCard",
        dependencyCheckpointIds: ["Avatar"],
        exportArtifact: false,
        projectRoot: tmpDir,
      },
    });
    expect(mergeResult.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(mergeResult));

    expect(parsed.staleCheckpointVersionWarnings).toHaveLength(1);
    expect(parsed.staleCheckpointVersionWarnings[0]).toContain("Avatar");
    expect(parsed.staleCheckpointVersionWarnings[0]).toContain("variants");
  });

  it("does NOT flag a component with only one checkpoint version — no false positive on the common case", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-merge-checkpoints-"));
    await seedCheckpoint(tmpDir, "SessionCard", loadFixture("session-card"));
    await seedCheckpoint(tmpDir, "Avatar", loadFixture("avatar"));

    const client = await connectedClient();
    const mergeResult = await client.callTool({
      name: "merge_design_ir_checkpoints",
      arguments: {
        primaryCheckpointId: "SessionCard",
        dependencyCheckpointIds: ["Avatar"],
        exportArtifact: false,
        projectRoot: tmpDir,
      },
    });
    const parsed = JSON.parse(textOf(mergeResult));
    expect(parsed.staleCheckpointVersionWarnings).toEqual([]);
  });
});
