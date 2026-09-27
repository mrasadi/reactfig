import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComponentDef, FrameNode } from "@reactfig/core";
import { connectedClient, loadFixture, textOf } from "../support/mcpTestClient.js";
import { openVersionedCheckpointDir, writeCheckpoint } from "../../src/checkpoint.js";

let tmpDir: string;
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

describe("MCP dispatch boundary — diff_design_ir", () => {
  it("compares two inline documents and reports no differences for an identical pair", async () => {
    const doc = loadFixture("session-card");
    const client = await connectedClient();
    const result = await client.callTool({ name: "diff_design_ir", arguments: { before: doc, after: clone(doc) } });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.identical).toBe(true);
    expect(parsed.entries).toEqual([]);
    expect(parsed.report).toContain("no semantic differences");
  });

  it("compares two inline documents and reports a bounds change", async () => {
    const before = loadFixture("session-card");
    const after = clone(before);
    const comp = after.components.find((c: ComponentDef) => c.id === "comp_sessioncard")! as ComponentDef;
    (comp.root as FrameNode).bounds.width += 5;

    const client = await connectedClient();
    const result = await client.callTool({ name: "diff_design_ir", arguments: { before, after } });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.identical).toBe(false);
    expect(parsed.summary.bounds).toBeGreaterThan(0);
    expect(parsed.entries.some((e: { path: string }) => e.path.endsWith("/bounds/width"))).toBe(true);
  });

  it("rejects an invalid inline document with a useful error rather than a raw crash", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "diff_design_ir",
      arguments: { before: { not: "a design document" }, after: loadFixture("session-card") },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toBeTruthy();
  });

  it("rejects a call that mixes an inline document and a checkpoint reference for the same side", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "diff_design_ir",
      arguments: { before: loadFixture("session-card"), beforeCheckpoint: "SessionCard", after: loadFixture("session-card") },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toMatch(/exactly one of/);
  });

  it("compares two checkpoint versions of the same component (v1 vs v2) by reference alone, with no document JSON in the call", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-diff-checkpoints-"));

    const v1Doc = loadFixture("session-card");
    const v1 = await openVersionedCheckpointDir(tmpDir, "SessionCard");
    await writeCheckpoint(v1, "designIr", v1Doc);

    const v2Doc = clone(v1Doc);
    const comp = v2Doc.components.find((c: ComponentDef) => c.id === "comp_sessioncard")! as ComponentDef;
    (comp.root as FrameNode).bounds.width += 2;
    const v2 = await openVersionedCheckpointDir(tmpDir, "SessionCard");
    await writeCheckpoint(v2, "designIr", v2Doc);

    const client = await connectedClient();
    const result = await client.callTool({
      name: "diff_design_ir",
      arguments: { beforeCheckpoint: "SessionCard@v1", afterCheckpoint: "SessionCard@v2", projectRoot: tmpDir },
    });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.identical).toBe(false);
    expect(parsed.resolvedBefore.checkpointRef).toBe("SessionCard@v001");
    expect(parsed.resolvedAfter.checkpointRef).toBe("SessionCard@v002");
    expect(parsed.entries.some((e: { path: string }) => e.path.endsWith("/bounds/width"))).toBe(true);
    expect(parsed.report).toContain("SessionCard@v001");
  });

  it("reports a clear error when a referenced checkpoint doesn't exist", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-diff-checkpoints-"));
    const client = await connectedClient();
    const result = await client.callTool({
      name: "diff_design_ir",
      arguments: { beforeCheckpoint: "NoSuchComponent", after: loadFixture("session-card"), projectRoot: tmpDir },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toMatch(/no checkpoints found/);
  });
});
