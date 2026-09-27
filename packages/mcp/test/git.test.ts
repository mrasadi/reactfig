import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getCurrentGitCommit, hashFileContent, isFileDirty, getChangedFilesSince } from "../src/git.js";

const execFileAsync = promisify(execFile);

let tmpDir: string;
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
}

async function commitAll(dir: string, message: string): Promise<void> {
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", message], { cwd: dir });
}

describe("git awareness (ADR 0017 §7) — optional enrichment, never a hard dependency", () => {
  it("getCurrentGitCommit returns undefined (not a throw) in a directory that isn't a Git repo", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-git-"));
    const commit = await getCurrentGitCommit(tmpDir);
    expect(commit).toBeUndefined();
  });

  it("getCurrentGitCommit returns undefined in a fresh Git repo with no commits yet", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-git-"));
    await initGitRepo(tmpDir);
    const commit = await getCurrentGitCommit(tmpDir);
    expect(commit).toBeUndefined();
  });

  it("getCurrentGitCommit returns the real HEAD sha once a commit exists", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-git-"));
    await initGitRepo(tmpDir);
    writeFileSync(join(tmpDir, "a.txt"), "hello");
    await commitAll(tmpDir, "initial");

    const commit = await getCurrentGitCommit(tmpDir);
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("getCurrentGitCommit returns undefined when `git` itself is not on PATH", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-git-"));
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const commit = await getCurrentGitCommit(tmpDir);
      expect(commit).toBeUndefined();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("hashFileContent produces a stable sha256:<hex> for identical content and a different one after an edit", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-git-"));
    const filePath = join(tmpDir, "Button.tsx");
    writeFileSync(filePath, "export const Button = () => <button />;");

    const first = await hashFileContent(filePath);
    const second = await hashFileContent(filePath);
    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);

    writeFileSync(filePath, "export const Button = () => <button>changed</button>;");
    const third = await hashFileContent(filePath);
    expect(third).not.toBe(first);
  });

  it("hashFileContent throws a real error for a nonexistent file — unlike the Git helpers, this is not optional enrichment", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-git-"));
    await expect(hashFileContent(join(tmpDir, "does-not-exist.tsx"))).rejects.toThrow();
  });

  it("isFileDirty returns undefined outside a Git repo, and true/false correctly inside one", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-git-"));
    expect(await isFileDirty(tmpDir, "a.txt")).toBeUndefined();

    await initGitRepo(tmpDir);
    writeFileSync(join(tmpDir, "a.txt"), "hello");
    await commitAll(tmpDir, "initial");
    expect(await isFileDirty(tmpDir, "a.txt")).toBe(false);

    writeFileSync(join(tmpDir, "a.txt"), "hello, edited");
    expect(await isFileDirty(tmpDir, "a.txt")).toBe(true);
  });

  it("getChangedFilesSince returns undefined outside a Git repo, and the real changed-file list inside one", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-git-"));
    expect(await getChangedFilesSince(tmpDir, "HEAD")).toBeUndefined();

    await initGitRepo(tmpDir);
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "a.txt"), "hello");
    await commitAll(tmpDir, "initial");
    const { stdout: firstCommit } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: tmpDir });

    writeFileSync(join(tmpDir, "src", "a.txt"), "hello, changed");
    writeFileSync(join(tmpDir, "src", "b.txt"), "new file");
    await commitAll(tmpDir, "second");

    const changed = await getChangedFilesSince(tmpDir, firstCommit.trim());
    expect(changed).toEqual(expect.arrayContaining([join("src", "a.txt"), join("src", "b.txt")]));
  });

  it("getChangedFilesSince returns undefined for a commit that doesn't resolve, rather than throwing", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reactfig-git-"));
    await initGitRepo(tmpDir);
    writeFileSync(join(tmpDir, "a.txt"), "hello");
    await commitAll(tmpDir, "initial");

    const changed = await getChangedFilesSince(tmpDir, "0000000000000000000000000000000000000000");
    expect(changed).toBeUndefined();
  });
});
