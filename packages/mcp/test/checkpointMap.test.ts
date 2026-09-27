import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DesignDocument } from "@reactfig/core";
import { openVersionedCheckpointDir, writeCheckpoint, initialManifest, patchManifest } from "../src/checkpoint.js";
import { readCheckpointMap, upsertCheckpointMapEntry, rebuildCheckpointMap, openOrResumeVersionedCheckpointDir, CHECKPOINT_MAP_SCHEMA_VERSION } from "../src/checkpointMap.js";
import { buildCapturePlan, type PlannedCaptureRequest } from "../src/capturePlan.js";

function loadFixture(name: string): DesignDocument {
  const path = fileURLToPath(new URL(`../../artifact/test/fixtures/design-ir/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8"));
}

let tmpDir: string;
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("checkpoint map (ADR 0017 §5, §6)", () => {
  it("readCheckpointMap returns an empty map (not a thrown error) when the file doesn't exist yet", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-map-"));
    const map = await readCheckpointMap(tmpDir);
    expect(map.schemaVersion).toBe(CHECKPOINT_MAP_SCHEMA_VERSION);
    expect(map.components).toEqual({});
  });

  it("upsertCheckpointMapEntry records latest version, source state, last completed stage, and validity — enough to resume without opening design-ir.json", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-map-"));
    const root = join(tmpDir, "checkpoints");
    const mapPath = join(tmpDir, "checkpoint-map.json");
    const dir = await openVersionedCheckpointDir(tmpDir, "SessionCard", { rootDir: root });

    let manifest = initialManifest("SessionCard", { file: "src/SessionCard.tsx", contentHash: "sha256:abc", gitCommit: "deadbeef" });
    await writeCheckpoint(dir, "manifest", manifest);
    manifest = await patchManifest(
      dir,
      { stages: { sourceInspection: "completed", capture: "completed", interpretation: "completed", designIr: "completed", validation: "completed" }, validation: { valid: true, errorCount: 0 } },
      manifest
    );

    await upsertCheckpointMapEntry(tmpDir, manifest, dir, { mapPath });

    const map = await readCheckpointMap(tmpDir, { mapPath });
    const entry = map.components.SessionCard;
    expect(entry).toBeDefined();
    expect(entry.latestVersion).toBe(1);
    expect(entry.latestCheckpoint).toBe("v001");
    expect(entry.sourceFile).toBe("src/SessionCard.tsx");
    expect(entry.sourceHash).toBe("sha256:abc");
    expect(entry.gitCommit).toBe("deadbeef");
    expect(entry.lastCompletedStage).toBe("validation");
    expect(entry.valid).toBe(true);
    expect(entry.designIr).toBe(join(".reactfig", "checkpoints", "SessionCard", "v001", "design-ir.json"));
  });

  it("does not embed the full Design IR document anywhere in the map file — it's an index, not the source of truth", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-map-"));
    const root = join(tmpDir, "checkpoints");
    const mapPath = join(tmpDir, "checkpoint-map.json");
    const dir = await openVersionedCheckpointDir(tmpDir, "SessionCard", { rootDir: root });
    let manifest = initialManifest("SessionCard", { file: "src/SessionCard.tsx", contentHash: "sha256:abc" });
    await writeCheckpoint(dir, "manifest", manifest);
    await writeCheckpoint(dir, "designIr", loadFixture("session-card"));
    manifest = await patchManifest(dir, { stages: { designIr: "completed" } }, manifest);
    await upsertCheckpointMapEntry(tmpDir, manifest, dir, { mapPath });

    const raw = readFileSync(mapPath, "utf-8");
    // A distinctive, sizeable value only present in the real design-ir.json
    // (a node id from the fixture) must never leak into the map file.
    expect(raw).not.toContain("comp_sessioncard");
    expect(raw.length).toBeLessThan(2000);
  });

  it("advancing a component to v002 updates the map's latestVersion without disturbing other components' entries", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-map-"));
    const root = join(tmpDir, "checkpoints");
    const mapPath = join(tmpDir, "checkpoint-map.json");

    const buttonDir1 = await openVersionedCheckpointDir(tmpDir, "Button", { rootDir: root });
    let buttonManifest = initialManifest("Button", { file: "src/Button.tsx", contentHash: "sha256:b1" });
    await writeCheckpoint(buttonDir1, "manifest", buttonManifest);
    await upsertCheckpointMapEntry(tmpDir, buttonManifest, buttonDir1, { mapPath });

    const avatarDir = await openVersionedCheckpointDir(tmpDir, "Avatar", { rootDir: root });
    const avatarManifest = initialManifest("Avatar", { file: "src/Avatar.tsx", contentHash: "sha256:a1" });
    await writeCheckpoint(avatarDir, "manifest", avatarManifest);
    await upsertCheckpointMapEntry(tmpDir, avatarManifest, avatarDir, { mapPath });

    const buttonDir2 = await openVersionedCheckpointDir(tmpDir, "Button", { rootDir: root });
    buttonManifest = initialManifest("Button", { file: "src/Button.tsx", contentHash: "sha256:b2" });
    await writeCheckpoint(buttonDir2, "manifest", buttonManifest);
    await upsertCheckpointMapEntry(tmpDir, buttonManifest, buttonDir2, { mapPath });

    const map = await readCheckpointMap(tmpDir, { mapPath });
    expect(map.components.Button.latestVersion).toBe(2);
    expect(map.components.Button.sourceHash).toBe("sha256:b2");
    // Avatar's entry from the interleaved write is untouched.
    expect(map.components.Avatar.latestVersion).toBe(1);
    expect(map.components.Avatar.sourceHash).toBe("sha256:a1");
  });

  it("a component's map entry is stale-detectable by comparing sourceHash to the current file's hash", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-map-"));
    const root = join(tmpDir, "checkpoints");
    const mapPath = join(tmpDir, "checkpoint-map.json");
    const dir = await openVersionedCheckpointDir(tmpDir, "SessionCard", { rootDir: root });
    const manifest = initialManifest("SessionCard", { file: "src/SessionCard.tsx", contentHash: "sha256:ABC" });
    await writeCheckpoint(dir, "manifest", manifest);
    await upsertCheckpointMapEntry(tmpDir, manifest, dir, { mapPath });

    const map = await readCheckpointMap(tmpDir, { mapPath });
    const currentSourceHash = "sha256:XYZ"; // simulates hashFileContent() on the now-modified source file
    expect(map.components.SessionCard.sourceHash).not.toBe(currentSourceHash); // stale
  });

  it("rebuildCheckpointMap reconstructs the map from manifests alone, reading only the latest version's manifest.json per component", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-map-"));
    const root = join(tmpDir, "checkpoints");
    const mapPath = join(tmpDir, "checkpoint-map.json");

    const buttonDir1 = await openVersionedCheckpointDir(tmpDir, "Button", { rootDir: root });
    let buttonManifest = initialManifest("Button", { file: "src/Button.tsx", contentHash: "sha256:b1" });
    await writeCheckpoint(buttonDir1, "manifest", buttonManifest);
    buttonManifest = await patchManifest(buttonDir1, { stages: { designIr: "completed" }, validation: { valid: true, errorCount: 0 } }, buttonManifest);

    const buttonDir2 = await openVersionedCheckpointDir(tmpDir, "Button", { rootDir: root });
    const buttonManifest2 = initialManifest("Button", { file: "src/Button.tsx", contentHash: "sha256:b2" });
    await writeCheckpoint(buttonDir2, "manifest", buttonManifest2);

    const avatarDir = await openVersionedCheckpointDir(tmpDir, "Avatar", { rootDir: root });
    const avatarManifest = initialManifest("Avatar", { file: "src/Avatar.tsx", contentHash: "sha256:a1" });
    await writeCheckpoint(avatarDir, "manifest", avatarManifest);

    // No map file written at all yet — simulates a crash before the map was
    // ever updated, or the map simply being deleted.
    const rebuilt = await rebuildCheckpointMap(tmpDir, { rootDir: root, mapPath });
    expect(rebuilt.components.Button.latestVersion).toBe(2);
    expect(rebuilt.components.Button.sourceHash).toBe("sha256:b2");
    expect(rebuilt.components.Avatar.latestVersion).toBe(1);

    const persisted = await readCheckpointMap(tmpDir, { mapPath });
    expect(persisted).toEqual(rebuilt);
  });

  it("rebuildCheckpointMap skips a version directory that has no manifest.json rather than fabricating an entry", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-map-"));
    const root = join(tmpDir, "checkpoints");
    const mapPath = join(tmpDir, "checkpoint-map.json");
    // A version directory with a design-ir.json but no manifest.json — as
    // if it predates ADR 0017, or a crash happened before the manifest's
    // first write.
    const legacyDir = join(root, "LegacyComponent", "v001");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "design-ir.json"), JSON.stringify(loadFixture("button")));

    const rebuilt = await rebuildCheckpointMap(tmpDir, { rootDir: root, mapPath });
    expect(rebuilt.components.LegacyComponent).toBeUndefined();
  });

  it("rebuildCheckpointMap produces an empty map (not a throw) when the checkpoints directory doesn't exist at all", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-checkpoint-map-"));
    const rebuilt = await rebuildCheckpointMap(tmpDir, { rootDir: join(tmpDir, "checkpoints"), mapPath: join(tmpDir, "checkpoint-map.json") });
    expect(rebuilt.components).toEqual({});
  });
});

describe("openOrResumeVersionedCheckpointDir — resumable multi-capture (Issue.md 'Implement Minimal Multi-Variant Capture')", () => {
  const requests: PlannedCaptureRequest[] = [
    { label: "default", url: "http://localhost:3000", selector: ".stat-card", viewport: { width: 1440, height: 900 } },
    { label: "variant=tone:success", url: "http://localhost:3000", selector: ".stat-card:nth-of-type(2)", viewport: { width: 1440, height: 900 }, propValues: { tone: "success" } },
  ];

  it("allocates a fresh version (not resumed) when the component has no checkpoint-map entry at all — the fast path, no manifest/plan file ever opened", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-resume-"));
    const root = join(tmpDir, "checkpoints");
    const mapPath = join(tmpDir, "checkpoint-map.json");
    const plan = buildCapturePlan("sha256:abc", requests);

    const result = await openOrResumeVersionedCheckpointDir(tmpDir, "StatCard", plan, { rootDir: root, mapPath });

    expect(result.resumed).toBe(false);
    expect(result.dir.version).toBe(1);
    expect(result.manifest).toBeNull();
    expect(result.plan.captures.every((c) => c.status === "pending")).toBe(true);
  });

  it("resumes the same version when a previous attempt left capture incomplete and the revisionKey matches exactly", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-resume-"));
    const root = join(tmpDir, "checkpoints");
    const mapPath = join(tmpDir, "checkpoint-map.json");
    const plan = buildCapturePlan("sha256:abc", requests);

    // Simulate a first attempt that captured entry 0 then failed on entry 1.
    const dir = await openVersionedCheckpointDir(tmpDir, "StatCard", { rootDir: root });
    let manifest = initialManifest("StatCard", { file: "src/StatCard.tsx", contentHash: "sha256:abc" });
    await writeCheckpoint(dir, "manifest", manifest);
    manifest = await patchManifest(dir, { stages: { sourceInspection: "completed", capture: "failed" } }, manifest);
    const inProgressPlan = { ...plan, captures: [{ ...plan.captures[0], status: "completed" as const }, { ...plan.captures[1], status: "failed" as const, error: "browser timeout" }] };
    await writeCheckpoint(dir, "capturePlan", inProgressPlan);
    await upsertCheckpointMapEntry(tmpDir, manifest, dir, { mapPath });

    const result = await openOrResumeVersionedCheckpointDir(tmpDir, "StatCard", plan, { rootDir: root, mapPath });

    expect(result.resumed).toBe(true);
    expect(result.dir.path).toBe(dir.path); // same version directory reused, not a new v002
    expect(result.dir.version).toBe(1);
    expect(result.plan.captures[0].status).toBe("completed"); // carried over — won't be recaptured
    expect(result.plan.captures[1].status).toBe("failed"); // eligible for retry
    expect(result.plan.captures[1].error).toBe("browser timeout");
  });

  it("does NOT resume when the previous checkpoint's capture stage already completed — a genuinely new generate_design_ir call always gets its own version", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-resume-"));
    const root = join(tmpDir, "checkpoints");
    const mapPath = join(tmpDir, "checkpoint-map.json");
    const plan = buildCapturePlan("sha256:abc", requests);

    const dir = await openVersionedCheckpointDir(tmpDir, "StatCard", { rootDir: root });
    let manifest = initialManifest("StatCard", { file: "src/StatCard.tsx", contentHash: "sha256:abc" });
    await writeCheckpoint(dir, "manifest", manifest);
    manifest = await patchManifest(dir, { stages: { sourceInspection: "completed", capture: "completed" } }, manifest);
    await writeCheckpoint(dir, "capturePlan", { ...plan, captures: plan.captures.map((c) => ({ ...c, status: "completed" as const })) });
    await upsertCheckpointMapEntry(tmpDir, manifest, dir, { mapPath });

    const result = await openOrResumeVersionedCheckpointDir(tmpDir, "StatCard", plan, { rootDir: root, mapPath });

    expect(result.resumed).toBe(false);
    expect(result.dir.version).toBe(2); // fresh version, v001 left untouched
  });

  it("does NOT resume when the requested capture set differs (different revisionKey) — falls back to a fresh version rather than mixing stale and fresh captures", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-resume-"));
    const root = join(tmpDir, "checkpoints");
    const mapPath = join(tmpDir, "checkpoint-map.json");
    const oldPlan = buildCapturePlan("sha256:abc", [requests[0]]); // only 1 capture requested last time

    const dir = await openVersionedCheckpointDir(tmpDir, "StatCard", { rootDir: root });
    let manifest = initialManifest("StatCard", { file: "src/StatCard.tsx", contentHash: "sha256:abc" });
    await writeCheckpoint(dir, "manifest", manifest);
    manifest = await patchManifest(dir, { stages: { sourceInspection: "completed", capture: "failed" } }, manifest);
    await writeCheckpoint(dir, "capturePlan", oldPlan);
    await upsertCheckpointMapEntry(tmpDir, manifest, dir, { mapPath });

    const newPlan = buildCapturePlan("sha256:abc", requests); // now 2 captures requested — different revisionKey
    const result = await openOrResumeVersionedCheckpointDir(tmpDir, "StatCard", newPlan, { rootDir: root, mapPath });

    expect(result.resumed).toBe(false);
    expect(result.dir.version).toBe(2);
  });

  it("does NOT resume when the map has an entry but the latest version predates capture-plan.json (no such file) — falls back cleanly, no crash", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-resume-"));
    const root = join(tmpDir, "checkpoints");
    const mapPath = join(tmpDir, "checkpoint-map.json");
    const plan = buildCapturePlan("sha256:abc", requests);

    const dir = await openVersionedCheckpointDir(tmpDir, "StatCard", { rootDir: root });
    let manifest = initialManifest("StatCard", { file: "src/StatCard.tsx", contentHash: "sha256:abc" });
    await writeCheckpoint(dir, "manifest", manifest);
    manifest = await patchManifest(dir, { stages: { sourceInspection: "completed", capture: "failed" } }, manifest);
    // No capture-plan.json written at all — pre-feature checkpoint.
    await upsertCheckpointMapEntry(tmpDir, manifest, dir, { mapPath });

    const result = await openOrResumeVersionedCheckpointDir(tmpDir, "StatCard", plan, { rootDir: root, mapPath });
    expect(result.resumed).toBe(false);
    expect(result.dir.version).toBe(2);
  });
});
