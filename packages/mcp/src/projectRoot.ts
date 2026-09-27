/**
 * Project-root resolution, in priority order (highest first):
 *
 * 1. An explicit `projectRoot` argument on the specific tool call.
 * 2. `--project <path>` / `REACTFIG_PROJECT_ROOT` — an operator-level
 *    override set once when the server is started.
 * 3. The MCP client's advertised workspace root, via the `roots/list`
 *    protocol feature (queried once after connecting, cached here).
 * 4. `process.cwd()` — a documented last resort, not the first guess.
 *
 * This ordering is the actual fix for a real portability bug (Phase 8):
 * previously, `process.cwd()` was used as soon as no `--project`/env var
 * was given, which pre-empted ever asking the MCP client for its
 * workspace root at all — meaning the server had no way to target
 * whatever project the client was actually working in unless the operator
 * hardcoded a path for every single project. See
 * docs/adr/0012-mcp-portability-and-reliability.md.
 */
export interface ProjectRootState {
  /** Set once at startup from --project / REACTFIG_PROJECT_ROOT, if provided. */
  explicit?: string;
  /** Resolved lazily from the MCP client's advertised workspace roots, after the connection handshake completes. */
  clientRoot?: string;
}

export function resolveProjectRoot(perCallRoot: string | undefined, state: ProjectRootState): string {
  return perCallRoot ?? state.explicit ?? state.clientRoot ?? process.cwd();
}

/** Reads the operator-level override from CLI args / environment. Returns undefined (not cwd) when neither is set, so the caller can still try the client's workspace root first. */
export function resolveExplicitRoot(argv: string[], env: NodeJS.ProcessEnv): string | undefined {
  const flagIndex = argv.indexOf("--project");
  if (flagIndex !== -1 && argv[flagIndex + 1]) return argv[flagIndex + 1];
  return env.REACTFIG_PROJECT_ROOT;
}