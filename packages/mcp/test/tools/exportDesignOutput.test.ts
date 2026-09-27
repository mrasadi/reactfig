import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unpack } from "@reactfig/artifact";
import { exportDesignArtifactTool } from "../../src/tools/exportDesignArtifact.js";
import { exportDesignOutputTool } from "../../src/tools/exportDesignOutput.js";
import type { DesignDocument } from "@reactfig/core";

function loadFixture(name: string): DesignDocument {
  const path = fileURLToPath(new URL(`../../../artifact/test/fixtures/design-ir/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8"));
}

let tmpDir: string;
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("exportDesignOutputTool — Output Intent", () => {
  it("defaults to rfd when format is omitted, the backward-compatible default", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-mcp-test-"));
    const result = await exportDesignOutputTool(
      { document: loadFixture("button"), outputPath: "Button.rfd", fetchAssets: false },
      { projectRoot: tmpDir, now: () => "2026-01-01T00:00:00.000Z" }
    );
    expect(result.format).toBe("rfd");
    expect(result.manifest).toBeDefined();

    const unpacked = await unpack(new Uint8Array(readFileSync(result.path)));
    expect(unpacked.document.id).toBe("doc_button_example");
  });

  it("produces byte-identical .rfd output to export_design_artifact for the same input (superset, not a fork)", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-mcp-test-"));
    const doc = loadFixture("button");
    const now = () => "2026-01-01T00:00:00.000Z";

    const a = await exportDesignArtifactTool({ document: doc, outputPath: "A.rfd", fetchAssets: false }, { projectRoot: tmpDir, now });
    const b = await exportDesignOutputTool({ document: doc, format: "rfd", outputPath: "B.rfd", fetchAssets: false }, { projectRoot: tmpDir, now });

    expect(Buffer.from(readFileSync(a.path)).equals(Buffer.from(readFileSync(b.path)))).toBe(true);
  });

  it("writes a JSON file that round-trips the Design IR document", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-mcp-test-"));
    const doc = loadFixture("button");
    const result = await exportDesignOutputTool({ document: doc, format: "json", outputPath: "Button.json" }, { projectRoot: tmpDir });
    expect(result.format).toBe("json");
    expect(result.manifest).toBeUndefined();
    expect(JSON.parse(readFileSync(result.path, "utf-8"))).toEqual(doc);
  });

  it("writes a standalone SVG file", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-mcp-test-"));
    const doc = loadFixture("session-card");
    const result = await exportDesignOutputTool({ document: doc, format: "svg" }, { projectRoot: tmpDir });
    expect(result.path.endsWith(".svg")).toBe(true);
    expect(readFileSync(result.path, "utf-8").startsWith("<svg")).toBe(true);
  });

  it("writes a standalone HTML file", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-mcp-test-"));
    const doc = loadFixture("session-card");
    const result = await exportDesignOutputTool({ document: doc, format: "html" }, { projectRoot: tmpDir });
    expect(result.path.endsWith(".html")).toBe(true);
    expect(readFileSync(result.path, "utf-8")).toContain("<!doctype html>");
  });

  it("rejects a format the schema doesn't know about by TypeScript typing (compile-time), and defaults gracefully at runtime for undefined", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-mcp-test-"));
    const result = await exportDesignOutputTool({ document: loadFixture("button"), format: undefined, fetchAssets: false }, { projectRoot: tmpDir, now: () => "2026-01-01T00:00:00.000Z" });
    expect(result.format).toBe("rfd");
  });
});
