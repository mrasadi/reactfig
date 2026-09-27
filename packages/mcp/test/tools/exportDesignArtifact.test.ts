import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unpack } from "@reactfig/artifact";
import { exportDesignArtifactTool } from "../../src/tools/exportDesignArtifact.js";
import type { DesignDocument } from "@reactfig/core";

function loadFixture(name: string): DesignDocument {
  const path = fileURLToPath(new URL(`../../../artifact/test/fixtures/design-ir/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8"));
}

let tmpDir: string;
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("exportDesignArtifactTool", () => {
  it("writes a real .rfd file that unpack()s back to a valid document", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-mcp-test-"));
    const result = await exportDesignArtifactTool(
      { document: loadFixture("button"), outputPath: "Button.rfd", fetchAssets: false },
      { projectRoot: tmpDir, now: () => "2026-01-01T00:00:00.000Z" }
    );

    expect(result.path).toBe(join(tmpDir, "Button.rfd"));
    expect(result.warnings).toEqual([]);

    const bytes = new Uint8Array(readFileSync(result.path));
    const unpacked = await unpack(bytes);
    expect(unpacked.document.id).toBe("doc_button_example");
    expect(unpacked.manifest.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("fetches an http(s) asset via the injected fetchImpl and embeds it", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-mcp-test-"));
    const doc = loadFixture("avatar");
    doc.assets[0] = { ...doc.assets[0], path: "http://localhost:3000/avatars/amir.png" };

    const fakeBytes = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = (async (url: string | URL) => {
      expect(String(url)).toBe("http://localhost:3000/avatars/amir.png");
      return { ok: true, status: 200, arrayBuffer: async () => fakeBytes.buffer } as Response;
    }) as typeof fetch;

    const result = await exportDesignArtifactTool(
      { document: doc, outputPath: "Avatar.rfd" },
      { projectRoot: tmpDir, fetchImpl, now: () => "2026-01-01T00:00:00.000Z" }
    );

    expect(result.warnings).toEqual([]);
    expect(result.manifest.assets[0].embedded).toBe(true);

    const bytes = new Uint8Array(readFileSync(result.path));
    const unpacked = await unpack(bytes);
    expect(unpacked.assets["asset_0"]).toEqual(fakeBytes);
  });

  it("records a fetch failure as a warning and still produces a valid artifact", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-mcp-test-"));
    const doc = loadFixture("avatar");
    doc.assets[0] = { ...doc.assets[0], path: "http://localhost:3000/missing.png" };

    const fetchImpl = (async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) })) as unknown as typeof fetch;

    const result = await exportDesignArtifactTool({ document: doc, outputPath: "Avatar.rfd" }, { projectRoot: tmpDir, fetchImpl });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/fetch returned 404/);
    expect(result.manifest.assets[0].embedded).toBe(false);
  });

  it("leaves a non-http(s) asset path unresolved without attempting to fetch it, and warns rather than failing silently", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-mcp-test-"));
    let fetchCalled = false;
    const fetchImpl = (async () => {
      fetchCalled = true;
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) } as Response;
    }) as typeof fetch;

    const result = await exportDesignArtifactTool({ document: loadFixture("avatar"), outputPath: "Avatar.rfd" }, { projectRoot: tmpDir, fetchImpl });

    expect(fetchCalled).toBe(false); // avatar.json's asset path is "/avatars/amir.png" — not http(s)
    expect(result.manifest.assets[0].embedded).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/not an http\(s\) URL, left unembedded/);
  });

  it("warns (but does not throw) when the document still contains unresolved external:<Name> component refs — the actual reported failure mode (a merge step was skipped or incomplete before export)", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-mcp-test-"));
    const sessionCard = loadFixture("session-card"); // references external:Avatar and external:Badge, unresolved — never merged

    const result = await exportDesignArtifactTool(
      { document: sessionCard, outputPath: "SessionCard.rfd", fetchAssets: false },
      { projectRoot: tmpDir }
    );

    const externalRefWarnings = result.warnings.filter((w) => w.includes("unresolved nested component ref"));
    expect(externalRefWarnings).toHaveLength(2);
    expect(externalRefWarnings.some((w) => w.includes("external:Avatar"))).toBe(true);
    expect(externalRefWarnings.some((w) => w.includes("external:Badge"))).toBe(true);
    // Still produces the artifact — this is a warning, not a validation failure (ADR 0008).
    const bytes = new Uint8Array(readFileSync(result.path));
    const unpacked = await unpack(bytes);
    expect(unpacked.document.id).toBe(sessionCard.id);
  });

  it("does not warn about external refs for a document with none to begin with (e.g. avatar.json has no nested instances)", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-mcp-test-"));
    const result = await exportDesignArtifactTool(
      { document: loadFixture("avatar"), outputPath: "Avatar.rfd", fetchAssets: false },
      { projectRoot: tmpDir }
    );

    expect(result.warnings.some((w) => w.includes("unresolved nested component ref"))).toBe(false);
  });

  it("warning count drops to match mergeDesignDocuments' own unresolvedExternalRefs once a partial merge resolves some (but not all) refs", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-mcp-test-"));
    const { mergeDesignDocuments } = await import("@reactfig/core");
    // avatar.json resolves external:Avatar; session-card.json has no
    // avatar.json equivalent for Badge in this fixture set, so
    // external:Badge is expected to remain — this asserts export's warning
    // count tracks that exactly, not that merge produces zero.
    const { document, unresolvedExternalRefs } = mergeDesignDocuments(loadFixture("session-card"), [loadFixture("avatar")]);
    expect(unresolvedExternalRefs).toEqual(["external:Badge"]);

    const result = await exportDesignArtifactTool({ document, outputPath: "SessionCard.rfd", fetchAssets: false }, { projectRoot: tmpDir });

    const externalRefWarnings = result.warnings.filter((w) => w.includes("unresolved nested component ref"));
    expect(externalRefWarnings).toHaveLength(1);
    expect(externalRefWarnings[0]).toContain("external:Badge");
  });

  it("resolves a relative outputPath against projectRoot", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-mcp-test-"));
    const result = await exportDesignArtifactTool(
      { document: loadFixture("session-card"), outputPath: "out/SessionCard.rfd", fetchAssets: false },
      { projectRoot: tmpDir }
    );
    expect(result.path).toBe(join(tmpDir, "out/SessionCard.rfd"));
  });

  it("decodes a data: URI asset directly (no fetch needed) and embeds it — docs/adr/0030, e.g. a captured inline <svg> icon", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-mcp-test-"));
    const doc = loadFixture("avatar");
    const svgMarkup = '<svg viewBox="0 0 24 24"><path fill="rgb(95,99,104)" d="M0 0h24v24H0z"></path></svg>';
    const dataUri = `data:image/svg+xml;base64,${Buffer.from(svgMarkup, "utf-8").toString("base64")}`;
    doc.assets[0] = { ...doc.assets[0], path: dataUri, mimeType: "image/svg+xml" };

    const result = await exportDesignArtifactTool({ document: doc, outputPath: "Icon.rfd" }, { projectRoot: tmpDir, now: () => "2026-01-01T00:00:00.000Z" });

    // No "left unembedded" warning — a data: URI never needed fetching.
    expect(result.warnings).toEqual([]);
    const unpacked = await unpack(new Uint8Array(readFileSync(result.path)));
    expect(unpacked.assets).toHaveProperty("asset_0");
    expect(Buffer.from(unpacked.assets["asset_0"]).toString("utf-8")).toBe(svgMarkup);
  });

  it("warns (rather than throwing) for a malformed data: URI, leaving it unembedded", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-mcp-test-"));
    const doc = loadFixture("avatar");
    doc.assets[0] = { ...doc.assets[0], path: "data:image/svg+xml;base64" }; // no comma separator

    const result = await exportDesignArtifactTool({ document: doc, outputPath: "Icon.rfd" }, { projectRoot: tmpDir, now: () => "2026-01-01T00:00:00.000Z" });

    expect(result.warnings.some((w) => w.includes("malformed data: URI"))).toBe(true);
  });
});
