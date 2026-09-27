# ADR 0001: TypeScript monorepo, pnpm workspaces

## Status
Accepted

## Context
The Figma plugin must be TypeScript/JS — there is no alternative, it's what
the Plugin API supports. The question was whether the MCP server and
analysis layer should be Python (common for AI tooling) or also TypeScript.

## Decision
Everything is TypeScript, in a single pnpm-workspace monorepo.

## Rationale
- `packages/core`'s Design IR types and JSON Schema can be imported directly
  by the MCP server, the analyzer, and the plugin. A Python MCP server would
  require a second, hand-maintained copy of the IR types that inevitably
  drifts from the TypeScript one used by the plugin.
- TSX/JSX AST analysis has first-class tooling in TypeScript (TS Compiler
  API, `ts-morph`). Python JSX parsers are second-class and would need to
  reimplement logic the TS ecosystem already has.
- Playwright's TypeScript API is at parity with (arguably better documented
  than) its Python API for this project's needs.
- pnpm workspaces are enough for 6 packages; no need for Nx/Turborepo at
  this stage.

## Consequences
- Contributors need one toolchain, not two.
- `packages/figma-plugin` still needs its own esbuild target since it runs
  in a sandboxed non-Node JS runtime — see ADR 0003.
