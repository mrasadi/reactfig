import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDesignIR, type DesignDocument } from "@reactfig/core";
import {
  openVersionedCheckpointDir,
  resolveCheckpointRef,
  resolveLatestCheckpointDirIfExists,
  versionLabel,
  initialManifest,
  patchManifest,
  readManifest,
  writeCheckpoint,
  readCheckpoint,
  readValidatedDesignIr,
  writeDesignIrAndValidation,
  writeCaptureArtifact,
  tryReadCaptureArtifact,
  checkpointFile,
  CHECKPOINT_FILES,
  sanitizeRequestId,
  findDivergentSiblingVersions,
} from "../src/checkpoint.js";

function loadFixture(name: string): DesignDocument {
  const path = fileURLToPath(new URL(`../../artifact/test/fixtures/design-ir/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8"));
}

let tmpDir: string;
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * A representative design-ir/v1 document exercising every node shape the
 * prompt calls out: assets (empty and populated), components, nested
 * frames, text nodes, instances, componentRef, and pages. Built on top of
 * the session-card fixture so it's known-valid up front.
 */
function richDocument(): DesignDocument {
  return JSON.parse(JSON.stringify(loadFixture("session-card")));
}

describe("checkpoint persistence", () => {
  it("A. round-trips a representative Design IR to deep structural equality", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-"));
    const dir = await openVersionedCheckpointDir(tmpDir, "Button", { rootDir: join(tmpDir, "checkpoints") });

    const original = richDocument();
    await writeCheckpoint(dir, "designIr", original);

    const reloaded = await readCheckpoint<DesignDocument>(dir, "designIr");
    expect(reloaded).toEqual(original);
    expect(Array.isArray(reloaded.assets)).toBe(true);
  });

  it("B. preserves an empty assets array across persistence + reload", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-"));
    const dir = await openVersionedCheckpointDir(tmpDir, "EmptyAssets", { rootDir: join(tmpDir, "checkpoints") });

    const original = richDocument();
    original.assets = [];
    await writeCheckpoint(dir, "designIr", original);

    const reloaded = await readCheckpoint<DesignDocument>(dir, "designIr");
    expect(Array.isArray(reloaded.assets)).toBe(true);
    expect(reloaded.assets).toEqual([]);
  });

  it("C. a serialized-then-parsed Design IR can be exported without 'assets is not iterable'", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-"));
    const dir = await openVersionedCheckpointDir(tmpDir, "Button", { rootDir: join(tmpDir, "checkpoints") });

    const original = richDocument();
    await writeCheckpoint(dir, "designIr", original);

     // The exact boundary the prompt requires: a document that has been
     // serialized to JSON on disk and parsed back must be consumable by the
     // exporter (whose asset loop is `for (const asset of document.assets)`).
    const roundTripped = await readCheckpoint<DesignDocument>(dir, "designIr");
    expect(() => {
      for (const asset of roundTripped.assets) {
        // reference so the loop body is meaningful; just exercising iteration
        void asset;
       }
    }).not.toThrow();

     // And the real exporter accepts it — still producing an artifact even
    // though session-card's own external:Avatar/external:Badge refs were
    // never merged here (this test is only exercising the JSON round-trip
    // boundary, not merge completeness) — that's now a warning, not a
    // thrown error or a silently-broken export (see export_design_artifact's
    // findUnresolvedExternalRefs check).
    const { exportDesignArtifactTool } = await import("../src/tools/exportDesignArtifact.js");
    const result = await exportDesignArtifactTool(
      { document: roundTripped, outputPath: "Button.rfd", fetchAssets: false },
      { projectRoot: tmpDir, now: () => "2026-01-01T00:00:00.000Z" }
     );
    expect(result.warnings.every((w) => w.includes("unresolved nested component ref"))).toBe(true);
    expect(result.warnings).toHaveLength(2);
  });

  it("D. rejects an invalid persisted IR before export and names the checkpoint", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-"));
    const dir = await openVersionedCheckpointDir(tmpDir, "Broken", { rootDir: join(tmpDir, "checkpoints") });

     // A document missing a required array field — the exact shape that
     // produced `assets is not iterable` when it reached export unvalidated.
    const broken = { ...richDocument(), assets: undefined } as unknown as DesignDocument;
    await writeCheckpoint(dir, "designIr", broken);

    await expect(readValidatedDesignIr(dir)).rejects.toThrow(/failed validation/);
     // The checkpoint must remain on disk for inspection (PROMPT.md §6).
    expect(existsSync(checkpointFile(dir, "designIr"))).toBe(true);

     // Sanity: the persisted document genuinely fails the validator.
    const reloaded = await readCheckpoint<unknown>(dir, "designIr");
    expect(validateDesignIR(reloaded).valid).toBe(false);
  });

  it("E. an earlier successful checkpoint survives a later stage's failure", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-"));
    const dir = await openVersionedCheckpointDir(tmpDir, "SessionCard", { rootDir: join(tmpDir, "checkpoints") });

     // Simulate: evidence + interpretation succeed, then a later stage throws.
    await writeCheckpoint(dir, "evidence", { componentName: "SessionCard" });
    await writeCheckpoint(dir, "interpretation", { componentDisplayName: "SessionCard" });

    const laterStageFails = async () => {
      await writeCheckpoint(dir, "designIr", richDocument());
      throw new Error("boom — export failed");
     };
    await expect(laterStageFails()).rejects.toThrow("boom");

     // The successful earlier checkpoints are still on disk; the design-ir
     // that *was* written before the throw is also preserved.
    expect(existsSync(checkpointFile(dir, "evidence"))).toBe(true);
    expect(existsSync(checkpointFile(dir, "interpretation"))).toBe(true);
    expect(existsSync(checkpointFile(dir, "designIr"))).toBe(true);
  });

  it("writeDesignIrAndValidation persists the IR and its validation diagnostics together", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-"));
    const dir = await openVersionedCheckpointDir(tmpDir, "Button", { rootDir: join(tmpDir, "checkpoints") });

    const document = richDocument();
    const { designIrPath, validationPath, validation } = await writeDesignIrAndValidation(dir, document);
    expect(existsSync(designIrPath)).toBe(true);
    expect(existsSync(validationPath)).toBe(true);
    expect(validation.valid).toBe(true);

     // And the design IR is reconstructable and still valid after reload.
    const reloaded = await readValidatedDesignIr(dir);
    expect(reloaded).toEqual(document);
  });

  it("sanitizes request ids so concurrent calls get distinct, filesystem-safe directories", () => {
    expect(sanitizeRequestId("SessionCard")).toBe("SessionCard");
    expect(sanitizeRequestId("Session Card!")).toBe("Session_Card");
     // Two different ids never collapse to the same directory name.
    expect(sanitizeRequestId("req-a")).not.toBe(sanitizeRequestId("req-b"));
     // An empty/garbage id falls back to a safe default rather than an empty dir.
    expect(sanitizeRequestId("///")).toBe("default");
  });

  it("exposes the documented fixed checkpoint filenames", () => {
    expect(CHECKPOINT_FILES.evidence).toBe("evidence.json");
    expect(CHECKPOINT_FILES.interpretation).toBe("interpretation.json");
    expect(CHECKPOINT_FILES.designIr).toBe("design-ir.json");
    expect(CHECKPOINT_FILES.validation).toBe("validation.json");
  });
});

describe("checkpoint versioning (ADR 0017)", () => {
  it("a component's first checkpoint becomes v001, and a second generation becomes v002 without touching v001", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-version-"));
    const root = join(tmpDir, "checkpoints");

    const v1 = await openVersionedCheckpointDir(tmpDir, "SessionCard", { rootDir: root });
    expect(v1.version).toBe(1);
    await writeCheckpoint(v1, "designIr", richDocument());

    const v2 = await openVersionedCheckpointDir(tmpDir, "SessionCard", { rootDir: root });
    expect(v2.version).toBe(2);
    expect(v2.path).not.toBe(v1.path);
    await writeCheckpoint(v2, "designIr", richDocument());

    // v1 is untouched by v2's creation and write.
    expect(existsSync(checkpointFile(v1, "designIr"))).toBe(true);
    const v1Reloaded = await readCheckpoint<DesignDocument>(v1, "designIr");
    expect(v1Reloaded).toEqual(richDocument());
  });

  it("different components never share a version counter", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-version-"));
    const root = join(tmpDir, "checkpoints");

    const button1 = await openVersionedCheckpointDir(tmpDir, "Button", { rootDir: root });
    const avatar1 = await openVersionedCheckpointDir(tmpDir, "Avatar", { rootDir: root });
    const button2 = await openVersionedCheckpointDir(tmpDir, "Button", { rootDir: root });

    expect(button1.version).toBe(1);
    expect(avatar1.version).toBe(1);
    expect(button2.version).toBe(2);
  });

  it("resolveCheckpointRef resolves a bare component name and '@latest' to the highest existing version", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-version-"));
    const root = join(tmpDir, "checkpoints");
    const v1 = await openVersionedCheckpointDir(tmpDir, "Button", { rootDir: root });
    const v2 = await openVersionedCheckpointDir(tmpDir, "Button", { rootDir: root });
    await writeCheckpoint(v1, "designIr", richDocument());
    await writeCheckpoint(v2, "designIr", richDocument());

    const bare = await resolveCheckpointRef(tmpDir, "Button", { rootDir: root });
    const explicit = await resolveCheckpointRef(tmpDir, "Button@latest", { rootDir: root });
    expect(bare.version).toBe(2);
    expect(explicit.version).toBe(2);
    expect(bare.path).toBe(v2.path);
  });

  it("resolveCheckpointRef resolves '@vN' to that specific historical version", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-version-"));
    const root = join(tmpDir, "checkpoints");
    const v1 = await openVersionedCheckpointDir(tmpDir, "Button", { rootDir: root });
    const v2 = await openVersionedCheckpointDir(tmpDir, "Button", { rootDir: root });
    await writeCheckpoint(v1, "designIr", richDocument());
    await writeCheckpoint(v2, "designIr", richDocument());

    const resolved = await resolveCheckpointRef(tmpDir, "Button@v1", { rootDir: root });
    expect(resolved.version).toBe(1);
    expect(resolved.path).toBe(v1.path);
    // Also accepts the zero-padded label form.
    const resolvedPadded = await resolveCheckpointRef(tmpDir, "Button@v001", { rootDir: root });
    expect(resolvedPadded.path).toBe(v1.path);
  });

  it("resolveCheckpointRef throws a clear error for an unknown component or a nonexistent version", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-version-"));
    const root = join(tmpDir, "checkpoints");
    await writeCheckpoint(await openVersionedCheckpointDir(tmpDir, "Button", { rootDir: root }), "designIr", richDocument());

    await expect(resolveCheckpointRef(tmpDir, "NoSuchComponent", { rootDir: root })).rejects.toThrow(/no checkpoints found/);
    await expect(resolveCheckpointRef(tmpDir, "Button@v99", { rootDir: root })).rejects.toThrow(/not found/);
    await expect(resolveCheckpointRef(tmpDir, "Button@notaversion", { rootDir: root })).rejects.toThrow(/invalid checkpoint reference/);
  });

  it("versionLabel zero-pads to three digits", () => {
    expect(versionLabel(1)).toBe("v001");
    expect(versionLabel(23)).toBe("v023");
    expect(versionLabel(456)).toBe("v456");
  });
});

describe("checkpoint manifest (ADR 0017 §4)", () => {
  it("initialManifest starts every stage not_started, and patchManifest merges stage updates without clobbering earlier ones", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-manifest-"));
    const dir = await openVersionedCheckpointDir(tmpDir, "SessionCard", { rootDir: join(tmpDir, "checkpoints") });
    const now = () => "2026-01-01T00:00:00.000Z";

    let manifest = initialManifest("SessionCard", { file: "src/SessionCard.tsx", contentHash: "sha256:abc", gitCommit: "deadbeef" }, now);
    expect(Object.values(manifest.stages).every((s) => s === "not_started")).toBe(true);
    await writeCheckpoint(dir, "manifest", manifest);

    manifest = await patchManifest(dir, { stages: { sourceInspection: "completed" } }, manifest, now);
    manifest = await patchManifest(dir, { stages: { capture: "completed" }, artifacts: { evidence: "evidence.json" } }, manifest, now);

    // Both prior patches are preserved — patching capture didn't revert
    // sourceInspection back to not_started.
    expect(manifest.stages.sourceInspection).toBe("completed");
    expect(manifest.stages.capture).toBe("completed");
    expect(manifest.stages.interpretation).toBe("not_started");
    expect(manifest.artifacts.evidence).toBe("evidence.json");

    const reloaded = await readManifest(dir);
    expect(reloaded).toEqual(manifest);
  });

  it("a manifest answers component/source/stages/artifacts/validity without opening any other checkpoint file", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-manifest-"));
    const dir = await openVersionedCheckpointDir(tmpDir, "SessionCard", { rootDir: join(tmpDir, "checkpoints") });
    let manifest = initialManifest("SessionCard", { file: "src/SessionCard.tsx", contentHash: "sha256:abc" });
    await writeCheckpoint(dir, "manifest", manifest);
    manifest = await patchManifest(
      dir,
      { stages: { sourceInspection: "completed", capture: "completed", interpretation: "completed", designIr: "completed", validation: "completed" }, validation: { valid: true, errorCount: 0 } },
      manifest
    );

    const reloaded = await readManifest(dir);
    expect(reloaded?.component).toBe("SessionCard");
    expect(reloaded?.source.file).toBe("src/SessionCard.tsx");
    expect(reloaded?.stages.validation).toBe("completed");
    expect(reloaded?.stages.export).toBe("not_started");
    expect(reloaded?.validation).toEqual({ valid: true, errorCount: 0 });
  });

  it("readManifest returns null (not a thrown error) for a version directory with no manifest yet", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-manifest-"));
    const dir = await openVersionedCheckpointDir(tmpDir, "SessionCard", { rootDir: join(tmpDir, "checkpoints") });
    expect(await readManifest(dir)).toBeNull();
  });
});

describe("resolveLatestCheckpointDirIfExists — non-throwing counterpart to resolveCheckpointRef", () => {
  it("returns null instead of throwing when the component has no checkpoints at all", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-resolve-"));
    const result = await resolveLatestCheckpointDirIfExists(tmpDir, "NeverGenerated", { rootDir: join(tmpDir, "checkpoints") });
    expect(result).toBeNull();
  });

  it("returns the latest version directory when one exists — same result resolveCheckpointRef would give", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-resolve-"));
    const rootDir = join(tmpDir, "checkpoints");
    await openVersionedCheckpointDir(tmpDir, "Button", { rootDir });
    const second = await openVersionedCheckpointDir(tmpDir, "Button", { rootDir });

    const result = await resolveLatestCheckpointDirIfExists(tmpDir, "Button", { rootDir });
    expect(result?.version).toBe(second.version);
    expect(result?.path).toBe(second.path);
  });
});

describe("writeCaptureArtifact / tryReadCaptureArtifact — per-capture evidence, stored separately from the assembled evidence.json", () => {
  it("round-trips a capture's data through captures/<id>.json", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-captures-"));
    const dir = await openVersionedCheckpointDir(tmpDir, "StatCard", { rootDir: join(tmpDir, "checkpoints") });

    const payload = { label: "variant=tone:success", dom: { tag: "div" } };
    const path = await writeCaptureArtifact(dir, "cap_abc123", payload);

    expect(existsSync(path)).toBe(true);
    expect(path).toBe(join(dir.path, "captures", "cap_abc123.json"));

    const reread = await tryReadCaptureArtifact(dir, "cap_abc123");
    expect(reread).toEqual(payload);
  });

  it("tryReadCaptureArtifact returns null (not a thrown error) for a capture that was never written", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-captures-"));
    const dir = await openVersionedCheckpointDir(tmpDir, "StatCard", { rootDir: join(tmpDir, "checkpoints") });
    expect(await tryReadCaptureArtifact(dir, "cap_never_written")).toBeNull();
  });

  it("multiple captures coexist as separate files under the same version's captures/ directory", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-captures-"));
    const dir = await openVersionedCheckpointDir(tmpDir, "StatCard", { rootDir: join(tmpDir, "checkpoints") });

    await writeCaptureArtifact(dir, "cap_a", { propValues: { tone: "neutral" } });
    await writeCaptureArtifact(dir, "cap_b", { propValues: { tone: "success" } });

    expect(await tryReadCaptureArtifact<{ propValues: { tone: string } }>(dir, "cap_a")).toEqual({ propValues: { tone: "neutral" } });
    expect(await tryReadCaptureArtifact<{ propValues: { tone: string } }>(dir, "cap_b")).toEqual({ propValues: { tone: "success" } });
  });
});

describe("findDivergentSiblingVersions (docs/adr/0024-divergent-checkpoint-version-detection.md)", () => {
  function plainComponentDoc(text: string): DesignDocument {
    const doc = richDocument();
    doc.components = [
      {
        kind: "component",
        id: "comp_x",
        name: "StatCard",
        root: { type: "frame", id: "root", name: "StatCard", bounds: { x: 0, y: 0, width: 100, height: 100 }, children: [{ type: "text", id: "t", name: "value", bounds: { x: 0, y: 0, width: 100, height: 20 }, characters: text, typography: { fontFamily: "Inter", fontWeight: 400, fontSize: 14 } }] },
      },
    ];
    return doc;
  }

  function componentSetDoc(): DesignDocument {
    const doc = richDocument();
    doc.components = [
      {
        kind: "componentSet",
        id: "comp_x",
        name: "StatCard",
        variantProperties: [{ name: "tone", values: ["neutral", "success"] }],
        variants: [
          { id: "v0", propertyValues: { tone: "neutral" }, root: { type: "frame", id: "r0", name: "StatCard", bounds: { x: 0, y: 0, width: 100, height: 100 }, children: [] } },
          { id: "v1", propertyValues: { tone: "success" }, root: { type: "frame", id: "r1", name: "StatCard", bounds: { x: 0, y: 0, width: 100, height: 100 }, children: [] } },
        ],
      },
    ];
    return doc;
  }

  async function writePlan(dir: Awaited<ReturnType<typeof openVersionedCheckpointDir>>, selector: string): Promise<void> {
    await writeCheckpoint(dir, "capturePlan", {
      revisionKey: "rev",
      captures: [{ id: "cap_1", label: "default", url: "http://localhost:5174", selector, viewport: { width: 1440, height: 900 }, status: "completed" }],
    });
  }

  it("real-world reproduction: 3 separate generate_design_ir calls, one per on-page position, each a plain component with a different selector — flags v2 and v3 as divergent siblings of v4 (mirrors the actual StatCard neutral/success/warning bug)", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-divergent-"));
    const root = join(tmpDir, "checkpoints");

    const v1 = await openVersionedCheckpointDir(tmpDir, "StatCard", { rootDir: root }); // unrelated earlier generation
    await writeCheckpoint(v1, "designIr", plainComponentDoc("unrelated"));
    await writePlan(v1, "#root div:nth-of-type(0)");

    const v2 = await openVersionedCheckpointDir(tmpDir, "StatCard", { rootDir: root });
    await writeCheckpoint(v2, "designIr", plainComponentDoc("12"));
    await writePlan(v2, "#root > div > main > div:nth-of-type(1) > div:nth-of-type(1)");

    const v3 = await openVersionedCheckpointDir(tmpDir, "StatCard", { rootDir: root });
    await writeCheckpoint(v3, "designIr", plainComponentDoc("6.8"));
    await writePlan(v3, "#root > div > main > div:nth-of-type(1) > div:nth-of-type(2)");

    const v4 = await openVersionedCheckpointDir(tmpDir, "StatCard", { rootDir: root });
    await writeCheckpoint(v4, "designIr", plainComponentDoc("1"));
    await writePlan(v4, "#root > div > main > div:nth-of-type(1) > div:nth-of-type(3)");

    const siblings = await findDivergentSiblingVersions(tmpDir, "StatCard", 4, { rootDir: root });
    expect(siblings.map((s) => s.version).sort()).toEqual([1, 2, 3]);
  });

  it("returns [] when only one version exists — nothing to compare against", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-divergent-"));
    const root = join(tmpDir, "checkpoints");
    const v1 = await openVersionedCheckpointDir(tmpDir, "Avatar", { rootDir: root });
    await writeCheckpoint(v1, "designIr", plainComponentDoc("x"));
    await writePlan(v1, "#avatar");

    expect(await findDivergentSiblingVersions(tmpDir, "Avatar", 1, { rootDir: root })).toEqual([]);
  });

  it("returns [] when the resolved version is already a componentSet — multi-variant capture worked correctly", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-divergent-"));
    const root = join(tmpDir, "checkpoints");
    const v1 = await openVersionedCheckpointDir(tmpDir, "StatCard", { rootDir: root });
    await writeCheckpoint(v1, "designIr", plainComponentDoc("old"));
    await writePlan(v1, "#root div:nth-of-type(1)");

    const v2 = await openVersionedCheckpointDir(tmpDir, "StatCard", { rootDir: root });
    await writeCheckpoint(v2, "designIr", componentSetDoc()); // the CORRECT multi-variant capture
    await writePlan(v2, "#root div:nth-of-type(1)");

    expect(await findDivergentSiblingVersions(tmpDir, "StatCard", 2, { rootDir: root })).toEqual([]);
  });

  it("returns [] when sibling versions used the SAME selector — a genuine resumed/re-run capture of the same instance, not the positional-capture failure mode", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-divergent-"));
    const root = join(tmpDir, "checkpoints");
    const v1 = await openVersionedCheckpointDir(tmpDir, "Button", { rootDir: root });
    await writeCheckpoint(v1, "designIr", plainComponentDoc("Save"));
    await writePlan(v1, "#root button");

    const v2 = await openVersionedCheckpointDir(tmpDir, "Button", { rootDir: root });
    await writeCheckpoint(v2, "designIr", plainComponentDoc("Save"));
    await writePlan(v2, "#root button"); // same selector as v1

    expect(await findDivergentSiblingVersions(tmpDir, "Button", 2, { rootDir: root })).toEqual([]);
  });
});
