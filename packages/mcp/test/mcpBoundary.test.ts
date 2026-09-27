import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unpack } from "@reactfig/artifact";
import { connectedClient, loadFixture, textOf } from "./support/mcpTestClient.js";

let tmpDir: string;
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("MCP dispatch boundary — export_design_artifact", () => {
  it("succeeds when a client sends the document as a real object over the wire (the normal, spec-compliant case)", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-mcp-boundary-"));
    const client = await connectedClient();
    const document = loadFixture("session-card");
    expect(Array.isArray(document.assets)).toBe(true);

    const exportResult = await client.callTool({
      name: "export_design_artifact",
      arguments: { document, outputPath: "SessionCard.rfd", fetchAssets: false, projectRoot: tmpDir },
    });

    expect(exportResult.isError).not.toBe(true);
    const exported = JSON.parse(textOf(exportResult));
    const bytes = new Uint8Array(readFileSync(exported.path));
    const unpacked = await unpack(bytes);
    expect(unpacked.document).toEqual(document);
  });

  it("does not throw 'assets is not iterable' when a client forwards the document pre-serialized as a JSON string, and still produces a valid artifact", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-mcp-boundary-"));
    const client = await connectedClient();
    const document = loadFixture("session-card");

    // Simulate an MCP client that forwards a prior tool result's raw text
    // content (already JSON, per the server's toResult()) as the next
    // call's `document` argument instead of parsing it back into an
    // object first — exactly what produced
    // `args.document.assets is not iterable` before the boundary
    // normalization fix in server.ts.
    const documentAsJsonString = JSON.stringify(document);

    const exportResult = await client.callTool({
      name: "export_design_artifact",
      arguments: { document: documentAsJsonString, outputPath: "SessionCard.rfd", fetchAssets: false, projectRoot: tmpDir },
    });

    if (exportResult.isError) {
      const content = exportResult.content as Array<{ type: string; text?: string }>;
      throw new Error(`export_design_artifact failed: ${content[0]?.text}`);
    }

    const exported = JSON.parse(textOf(exportResult));
    const bytes = new Uint8Array(readFileSync(exported.path));
    const unpacked = await unpack(bytes);
    expect(Array.isArray(unpacked.document.assets)).toBe(true);
    expect(unpacked.document).toEqual(document);
  });

  it("reports a clear validation error (not a raw TypeError) for a document string that isn't valid JSON", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-mcp-boundary-"));
    const client = await connectedClient();

    const exportResult = await client.callTool({
      name: "export_design_artifact",
      arguments: { document: "{not valid json", outputPath: "Button.rfd", fetchAssets: false, projectRoot: tmpDir },
    });

    expect(exportResult.isError).toBe(true);
    const content = exportResult.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toMatch(/not valid JSON/);
    expect(content[0]?.text).not.toMatch(/is not iterable/);
  });

  it("reports a clear design-ir/v1 validation error (not a raw TypeError) when assets is missing entirely", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-mcp-boundary-"));
    const client = await connectedClient();
    const document = loadFixture("session-card") as unknown as Record<string, unknown>;
    delete document.assets;

    const exportResult = await client.callTool({
      name: "export_design_artifact",
      arguments: { document, outputPath: "SessionCard.rfd", fetchAssets: false, projectRoot: tmpDir },
    });

    expect(exportResult.isError).toBe(true);
    const content = exportResult.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).not.toMatch(/is not iterable/);
  });

  it("marks a checkpoint's export stage completed and updates checkpoint-map.json when checkpointRef is given (ADR 0017)", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-mcp-boundary-"));
    const document = loadFixture("button");

    // Seed a checkpoint + manifest directly (as generate_design_ir would
    // have left on disk) rather than driving generate_design_ir's real
    // Playwright capture through the dispatch layer — this test is about
    // export_design_artifact's checkpointRef bookkeeping, not capture.
    const { openVersionedCheckpointDir, writeCheckpoint, initialManifest, patchManifest } = await import("../src/checkpoint.js");
    const { upsertCheckpointMapEntry } = await import("../src/checkpointMap.js");
    const dir = await openVersionedCheckpointDir(tmpDir, "Button");
    let manifest = initialManifest("Button", { file: "react/Button.tsx", contentHash: "sha256:abc" });
    await writeCheckpoint(dir, "manifest", manifest);
    await writeCheckpoint(dir, "designIr", document);
    manifest = await patchManifest(dir, { stages: { designIr: "completed", validation: "completed" }, validation: { valid: true, errorCount: 0 } }, manifest);
    await upsertCheckpointMapEntry(tmpDir, manifest, dir);

    const client = await connectedClient();
    const exportResult = await client.callTool({
      name: "export_design_artifact",
      arguments: { document, outputPath: "Button.rfd", fetchAssets: false, checkpointRef: "Button@v1", projectRoot: tmpDir },
    });
    expect(exportResult.isError).not.toBe(true);

    const manifestPath = join(dir.path, "manifest.json");
    const reloadedManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(reloadedManifest.stages.export).toBe("completed");

    const mapPath = join(tmpDir, ".reactfig", "checkpoint-map.json");
    const map = JSON.parse(readFileSync(mapPath, "utf-8"));
    expect(map.components.Button.lastCompletedStage).toBe("export");
  });

  it("does not fail the export itself when checkpointRef doesn't resolve to a real checkpoint — bookkeeping only", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-mcp-boundary-"));
    const client = await connectedClient();
    const document = loadFixture("session-card");

    const exportResult = await client.callTool({
      name: "export_design_artifact",
      arguments: { document, outputPath: "SessionCard.rfd", fetchAssets: false, checkpointRef: "NoSuchComponent", projectRoot: tmpDir },
    });

    expect(exportResult.isError).not.toBe(true);
    const exported = JSON.parse(textOf(exportResult));
    expect(existsSync(exported.path)).toBe(true);
  });

  it("sources the document straight from a checkpoint when `document` is omitted and `checkpointRef` is given", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-mcp-boundary-"));
    const document = loadFixture("session-card");
    const { openVersionedCheckpointDir, writeCheckpoint } = await import("../src/checkpoint.js");
    // Mirrors exactly what generate_design_ir already leaves on disk —
    // no `document` argument is passed to export_design_artifact below,
    // only a reference to this checkpoint.
    const dir = await openVersionedCheckpointDir(tmpDir, "SessionCard");
    await writeCheckpoint(dir, "designIr", document);

    const client = await connectedClient();
    const exportResult = await client.callTool({
      name: "export_design_artifact",
      arguments: { outputPath: "SessionCard.rfd", fetchAssets: false, checkpointRef: "SessionCard@v1", projectRoot: tmpDir },
    });

    expect(exportResult.isError).not.toBe(true);
    const exported = JSON.parse(textOf(exportResult));
    const bytes = new Uint8Array(readFileSync(exported.path));
    const unpacked = await unpack(bytes);
    expect(unpacked.document).toEqual(document);
  });

  it("reports a clear error, not a silent no-op, when neither `document` nor `checkpointRef` is given", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-mcp-boundary-"));
    const client = await connectedClient();

    const exportResult = await client.callTool({
      name: "export_design_artifact",
      arguments: { outputPath: "SessionCard.rfd", fetchAssets: false, projectRoot: tmpDir },
    });

    expect(exportResult.isError).toBe(true);
    const content = exportResult.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toMatch(/supply either .document. or .checkpointRef./);
  });
});