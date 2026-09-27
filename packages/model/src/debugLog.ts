/**
 * Stage-level diagnostic logging for the pipeline, added in response to a
 * real production symptom: `generate_design_ir` returning "MCP error
 * -32001: Request timed out" with no information about which of the
 * ~15 async stages between "MCP request received" and "request completed"
 * was actually slow or stuck — including model HTTP requests themselves
 * (e.g. a large local model via Ollama taking longer than expected). See
 * docs/adr/0013-generate-design-ir-timeout.md.
 *
 * Lives here in `@reactfig/model` (rather than `@reactfig/analyzer`, which
 * depends on this package) so both packages share one implementation
 * instead of a byte-for-byte duplicate — `@reactfig/analyzer` re-exports
 * this module from its own `index.ts` rather than keeping a second copy,
 * so nothing outside this file needs to know it moved.
 *
 * Writes to `stderr` ONLY, and only when `REACTFIG_DEBUG=true`/`1` — an
 * MCP `stdio` transport uses `stdout` as the wire protocol itself, so a
 * single accidental `console.log` here would corrupt every JSON-RPC
 * message on the connection. This module never touches `stdout`, gated or
 * not.
 *
 * Also, optionally, mirrors the same lines to a plain log file — added
 * after a real report where `REACTFIG_DEBUG=true` was set but no `stderr`
 * output was visible at all in the MCP client's own UI. That's expected,
 * not a bug in this module: many MCP clients (confirmed for OpenCode) do
 * not surface a stdio server's `stderr` back to the user anywhere in the
 * chat interface — it's swallowed or only visible in the client's own
 * internal logs, if at all. A file on disk is visible regardless of what
 * the client does with `stderr`. Off by default (no surprise disk
 * writes); enabled by setting `REACTFIG_DEBUG_LOG_FILE` to a path, or
 * automatically to `<os.tmpdir()>/reactfig-debug.log` when
 * `REACTFIG_DEBUG=true` and no explicit path is given, so there is always
 * one predictable place to look. See docs/adr/0013's addendum.
 *
 * Deliberately not a permanent, always-on log: most invocations don't need
 * per-stage timing, and unconditional stderr noise on every tool call is
 * its own kind of pollution for a client that surfaces server stderr to
 * the user. `REACTFIG_DEBUG` is the one supported way to turn this on.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const processStart = Date.now();

export function isDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REACTFIG_DEBUG === "true" || env.REACTFIG_DEBUG === "1";
}

function resolveLogFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.REACTFIG_DEBUG_LOG_FILE || join(tmpdir(), "reactfig-debug.log");
}

let loggedFilePathOnce = false;

export function debugLog(stage: string, detail?: Record<string, unknown>): void {
  if (!isDebugEnabled()) return;
  const elapsed = Date.now() - processStart;
  const suffix = detail ? ` ${JSON.stringify(detail)}` : "";
  const line = `[reactfig +${elapsed}ms] ${stage}${suffix}\n`;
  process.stderr.write(line);

  try {
    const filePath = resolveLogFilePath();
    if (!loggedFilePathOnce) {
      loggedFilePathOnce = true;
      process.stderr.write(`[reactfig] also writing this log to ${filePath} (see REACTFIG_DEBUG_LOG_FILE)\n`);
    }
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, line);
  } catch {
    // A diagnostics feature must never break the pipeline it's diagnosing.
  }
}
