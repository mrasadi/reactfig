import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unpack } from "@reactfig/artifact";
import { connectedClient, loadFixture, textOf } from "./support/mcpTestClient.js";
import type { ComponentDef, Node } from "@reactfig/core";

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

let tmpDir: string;
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("MCP dispatch boundary — merge_design_ir_documents", () => {
  it("resolves external:Avatar against a real object dependency, reports external:Badge unresolved, and the merged document exports and unpacks cleanly", async () => {
    const client = await connectedClient();
    const sessionCard = loadFixture("session-card");
    const avatar = loadFixture("avatar");

    const mergeResult = await client.callTool({
      name: "merge_design_ir_documents",
      arguments: { primary: sessionCard, dependencies: [avatar] },
    });
    expect(mergeResult.isError).not.toBe(true);
    const merged = JSON.parse(textOf(mergeResult));
    expect(merged.unresolvedExternalRefs).toEqual(["external:Badge"]);

    const sessionCardComp = merged.document.components.find((c: ComponentDef) => c.id === "comp_sessioncard");
    const avatarInstance = findInstance(sessionCardComp.root, "Avatar")!;
    expect(avatarInstance.componentRef).toEqual({ kind: "component", componentId: "comp_avatar" });
    expect(merged.document.components.some((c: ComponentDef) => c.id === "comp_avatar")).toBe(true);

    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-merge-"));
    const exportResult = await client.callTool({
      name: "export_design_artifact",
      arguments: { document: merged.document, outputPath: "SessionCard.rfd", fetchAssets: false, projectRoot: tmpDir },
    });
    expect(exportResult.isError).not.toBe(true);
    const exported = JSON.parse(textOf(exportResult));
    const bytes = new Uint8Array(readFileSync(exported.path));
    const unpacked = await unpack(bytes);
    // The previously-unresolved Avatar instance now points at a real, present component.
    const unpackedSessionCardComp = unpacked.document.components.find((c) => c.id === "comp_sessioncard")!;
    const unpackedAvatarInstance = findInstance((unpackedSessionCardComp as ComponentDef).root, "Avatar")!;
    expect(unpackedAvatarInstance.componentRef).toEqual({ kind: "component", componentId: "comp_avatar" });
  });

  it("threads instanceOverrides through to the merged document's matching instance node (Issue.md Fix 2c)", async () => {
    const client = await connectedClient();
    const sessionCard = loadFixture("session-card");
    const avatar = loadFixture("avatar");

    const mergeResult = await client.callTool({
      name: "merge_design_ir_documents",
      arguments: {
        primary: sessionCard,
        dependencies: [avatar],
        instanceOverrides: { node_avatar_instance: [{ path: [], fills: [{ type: "solid", color: { r: 0, g: 0.6, b: 0.3, a: 1 } }] }] },
      },
    });
    expect(mergeResult.isError).not.toBe(true);
    const merged = JSON.parse(textOf(mergeResult));
    const sessionCardComp = merged.document.components.find((c: ComponentDef) => c.id === "comp_sessioncard");
    const avatarInstance = findInstance(sessionCardComp.root, "Avatar")!;
    expect(avatarInstance.overrides).toEqual([{ path: [], fills: [{ type: "solid", color: { r: 0, g: 0.6, b: 0.3, a: 1 } }] }]);
  });

  it("resolves against a dependency forwarded as a pre-serialized JSON string, same as export_design_artifact's document normalization", async () => {
    const client = await connectedClient();
    const sessionCard = loadFixture("session-card");
    const avatar = loadFixture("avatar");

    const mergeResult = await client.callTool({
      name: "merge_design_ir_documents",
      arguments: { primary: JSON.stringify(sessionCard), dependencies: [JSON.stringify(avatar)] },
    });

    expect(mergeResult.isError).not.toBe(true);
    const merged = JSON.parse(textOf(mergeResult));
    const sessionCardComp = merged.document.components.find((c: ComponentDef) => c.id === "comp_sessioncard");
    const avatarInstance = findInstance(sessionCardComp.root, "Avatar")!;
    expect(avatarInstance.componentRef).toEqual({ kind: "component", componentId: "comp_avatar" });
  });

  it("reports a clear validation error (not a raw crash) when a dependency isn't a valid design-ir/v1 document", async () => {
    const client = await connectedClient();
    const sessionCard = loadFixture("session-card");

    const mergeResult = await client.callTool({
      name: "merge_design_ir_documents",
      arguments: { primary: sessionCard, dependencies: [{ not: "a design document" }] },
    });

    expect(mergeResult.isError).toBe(true);
    const content = mergeResult.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toMatch(/Invalid design-ir\/v1 document/);
  });

  it("resolves a componentSet dependency (Button) to a variant ref, and the exported/unpacked artifact carries that variant ref through unchanged", async () => {
    const client = await connectedClient();
    const sessionCard = loadFixture("session-card");
    const button = loadFixture("button");
    const sessionCardComp = sessionCard.components.find((c) => c.id === "comp_sessioncard") as ComponentDef;
    (sessionCardComp.root as Extract<Node, { type: "frame" }>).children.push({
      type: "instance",
      id: "node_button_ref",
      name: "Button",
      bounds: { x: 0, y: 0, width: 100, height: 40 },
      componentRef: { kind: "component", componentId: "external:Button" },
    });

    const mergeResult = await client.callTool({
      name: "merge_design_ir_documents",
      arguments: { primary: sessionCard, dependencies: [button] },
    });
    expect(mergeResult.isError).not.toBe(true);
    const merged = JSON.parse(textOf(mergeResult));

    const mergedSessionCardComp = merged.document.components.find((c: ComponentDef) => c.id === "comp_sessioncard");
    const buttonInstance = findInstance(mergedSessionCardComp.root, "Button")!;
    expect(buttonInstance.componentRef).toEqual({ kind: "variant", componentSetId: "comp_button", variantId: "comp_button_primary_large" });

    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-merge-"));
    const exportResult = await client.callTool({
      name: "export_design_artifact",
      arguments: { document: merged.document, outputPath: "SessionCard.rfd", fetchAssets: false, projectRoot: tmpDir },
    });
    expect(exportResult.isError).not.toBe(true);
    const exported = JSON.parse(textOf(exportResult));
    const bytes = new Uint8Array(readFileSync(exported.path));
    const unpacked = await unpack(bytes);
    const unpackedSessionCardComp = unpacked.document.components.find((c) => c.id === "comp_sessioncard")!;
    const unpackedButtonInstance = findInstance((unpackedSessionCardComp as ComponentDef).root, "Button")!;
    expect(unpackedButtonInstance.componentRef).toEqual({ kind: "variant", componentSetId: "comp_button", variantId: "comp_button_primary_large" });
  });
});