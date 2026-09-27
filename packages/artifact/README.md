# @reactfig/artifact

Packs and unpacks the portable `.rfd` artifact format — the clean boundary
between AI/design generation (`@reactfig/analyzer`) and any future renderer
(Figma or otherwise). No Figma dependency anywhere in this package.

```
DesignDocument (design-ir/v1) + asset bytes
        │  pack()
        ▼
   .rfd (zip)
     ├─ manifest.json     artifact metadata — version, root, asset embedding status
     ├─ ir.json            the Design IR document, asset paths rewritten to be self-contained
     └─ assets/             embedded asset bytes, only for assets bytes were provided for
        │  unpack()
        ▼
{ manifest, document, assets }
```

## API

```ts
import { pack, unpack, checkArtifact, inspect } from "@reactfig/artifact";

const { bytes, manifest } = await pack(document, {
  assetBytes: { "/avatars/amir.png": pngBytes }, // keyed by the AssetRef.path as it appears in `document.assets`
});

const { manifest, document, assets } = await unpack(bytes); // throws with a specific message on any problem

const check = await checkArtifact(bytes); // non-throwing — { valid, errors: string[] }, reports every problem in one pass

const summary = inspect(await unpack(bytes)); // { componentCount, variantCount, nodeCount, assetCount, embeddedAssetCount, ... }
```

## Developer CLI

```bash
pnpm --filter @reactfig/artifact build
node scripts/inspect-cli.js path/to/SessionCard.rfd
```

Validates first (`checkArtifact`), then prints artifact version, IR
version, root component, and component/variant/node/asset counts. See
`scripts/inspect-cli.ts` — it imports from built (`../dist`) output since
Node's native TS type-stripping doesn't remap a `.js` import specifier to
a sibling `.ts` file, so the package must be built first.

## Determinism

`pack()` produces byte-identical output for identical input, independent
of the input document's key insertion order: `manifest.json`/`ir.json` are
serialized with sorted keys at every level, and zip entries use a fixed
timestamp (`FIXED_ZIP_DATE` in `pack.ts`) so per-run wall-clock time never
leaks into archive bytes. The one genuinely non-deterministic field,
`manifest.createdAt`, is explicit, top-level, injectable
(`PackOptions.createdAt`), and kept separate from the design payload —
never mixed into `ir.json` or used to influence zip entry ordering. See
`docs/adr/0009-artifact-format.md`, "Determinism" for the full reasoning.

## Assets

`pack()` rewrites every `AssetRef.path` from its evidence-captured original
location (typically a dev-server-relative URL) to an artifact-relative path
(`assets/<id>.<ext>`) whenever bytes were supplied for it — this is what
lets a future Figma plugin resolve every embedded asset from the archive
alone, with no access to the developer's React repository or dev server.
An asset without supplied bytes is still recorded honestly in the manifest
(`embedded: false`) rather than silently dropped or failing the whole
pack — see ADR 0009, "Assets".

## Validation

Both `unpack()` (throws on the first problem) and `checkArtifact()`
(collects every problem) run the same five checks: manifest schema, Design
IR schema, artifact/IR version compatibility, asset-reference completeness
(every `ir.json` asset has a manifest entry, every embedded manifest entry
has a matching file), and package integrity (valid zip, required files
present).

## Golden fixtures

`test/fixtures/design-ir/` — hand-authored, realistic (not artificial
minimal) Design IR documents:

- `button.json` — a `ComponentSet` with 2 variants (also used as
  `docs/design-ir/example.button.json`'s canonical example).
- `session-card.json` — nested components collapsed to `Instance` nodes
  (`external:Avatar`, `external:Badge`) and a CSS Grid fallback region
  (`layout.mode: "none"` with absolute child bounds).
- `avatar.json` — a single image-containing component with an `AssetRef`.

For the "responsive component" scenario, see
`packages/analyzer/test/e2e/fullChain.test.ts` instead — responsiveness is
an evidence-level concept resolved away into one representative layout by
the time a Design IR document exists (see ADR 0009), so it's demonstrated
via the full pipeline (two-viewport evidence → mocked interpretation → IR →
`.rfd`), not as a static IR fixture here.
