/**
 * Small developer-facing utility for inspecting an .rfd artifact.
 *
 *   pnpm --filter @reactfig/artifact build
 *   node scripts/inspect-cli.js path/to/SessionCard.rfd
 *
 * Imports from ../dist (built output), not ../src — Node's native TS
 * type-stripping does not remap a `.js`-suffixed import specifier to a
 * sibling `.ts` file (that's build-tool behavior, not a Node runtime
 * feature), so this script only resolves correctly once the package has
 * been built. This file is itself written in TS for consistency with the
 * rest of the package, but is meant to be compiled — see the build step
 * above — not run directly via a TS loader against ../src.
 *
 * Not a full "reactfig" global CLI (that's future MCP/CLI-package scope,
 * per docs/architecture.md's optional CLI section) — just the minimal
 * "show useful information about an artifact" tool this phase asked for.
 * Validates first via checkArtifact so a broken artifact gets every
 * problem reported, not a stack trace.
 */
import { readFile } from "node:fs/promises";
import { checkArtifact } from "../dist/validateArtifact.js";
import { unpack } from "../dist/unpack.js";
import { inspect } from "../dist/inspect.js";

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("usage: inspect-cli.ts <path-to.rfd>");
    process.exitCode = 1;
    return;
  }

  const bytes = new Uint8Array(await readFile(filePath));

  const check = await checkArtifact(bytes);
  if (!check.valid) {
    console.error(`${filePath} is not a valid .rfd artifact:`);
    for (const err of check.errors) console.error(`  - ${err}`);
    process.exitCode = 1;
    return;
  }

  const unpacked = await unpack(bytes);
  const summary = inspect(unpacked);

  console.log(`Artifact: ${filePath}`);
  console.log(`  artifact version:   ${summary.artifactVersion}`);
  console.log(`  design-ir version:  ${summary.designIrVersion}`);
  console.log(`  root:               ${summary.rootComponentName} (${summary.rootComponentKind})`);
  console.log(`  components:         ${summary.componentCount}`);
  console.log(`  variants:           ${summary.variantCount}`);
  console.log(`  nodes:              ${summary.nodeCount}`);
  console.log(`  assets:             ${summary.assetCount} (${summary.embeddedAssetCount} embedded)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
