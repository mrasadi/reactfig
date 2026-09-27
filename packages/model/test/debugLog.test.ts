import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { debugLog, isDebugEnabled } from "../src/debugLog.js";

// This is the single implementation shared by @reactfig/model and
// @reactfig/analyzer (which re-exports it — see debugLog.ts's header
// comment and docs/adr/0013-generate-design-ir-timeout.md). Previously
// duplicated byte-for-byte in both packages with its own copy of this
// test; consolidated to one file here after the duplication was removed.
describe("debugLog — docs/adr/0013-generate-design-ir-timeout.md", () => {
  const logFile = join(tmpdir(), `reactfig-debuglog-test-${process.pid}.log`);

  beforeEach(() => {
    if (existsSync(logFile)) rmSync(logFile);
  });

  afterEach(() => {
    if (existsSync(logFile)) rmSync(logFile);
    vi.restoreAllMocks();
  });

  it('isDebugEnabled recognizes both "true" and "1", and defaults to false', () => {
    expect(isDebugEnabled({})).toBe(false);
    expect(isDebugEnabled({ REACTFIG_DEBUG: "false" })).toBe(false);
    expect(isDebugEnabled({ REACTFIG_DEBUG: "true" })).toBe(true);
    expect(isDebugEnabled({ REACTFIG_DEBUG: "1" })).toBe(true);
  });

  it("writes nothing to stderr when REACTFIG_DEBUG is unset", () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.stubEnv("REACTFIG_DEBUG", "");
    debugLog("some stage", { detail: 1 });
    expect(writeSpy).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("writes a timestamped line to stderr, and mirrors it to a log file, when enabled", () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.stubEnv("REACTFIG_DEBUG", "true");
    vi.stubEnv("REACTFIG_DEBUG_LOG_FILE", logFile);

    debugLog("navigation finished", { url: "http://localhost:5173" });

    expect(writeSpy).toHaveBeenCalled();
    const firstLine = (writeSpy.mock.calls[0]?.[0] as string) ?? "";
    expect(firstLine).toMatch(/^\[reactfig \+\d+ms\] navigation finished/);
    expect(firstLine).toContain('"url":"http://localhost:5173"');

    expect(existsSync(logFile)).toBe(true);
    expect(readFileSync(logFile, "utf8")).toContain("navigation finished");

    vi.unstubAllEnvs();
  });

  it("never throws even if the log file can't be written", () => {
    // A path under a plain file (not a directory) reliably fails fast with
    // ENOTDIR on mkdirSync — unlike some virtual filesystems (e.g. /proc),
    // which can hang rather than error on a bad mkdirSync target.
    writeFileSync(logFile, "not a directory");
    vi.stubEnv("REACTFIG_DEBUG", "true");
    vi.stubEnv("REACTFIG_DEBUG_LOG_FILE", join(logFile, "nested", "debug.log"));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(() => {
      debugLog("browser launch started");
      debugLog("navigation finished", { url: "http://localhost:5173" });
    }).not.toThrow();

    vi.unstubAllEnvs();
  });
});
