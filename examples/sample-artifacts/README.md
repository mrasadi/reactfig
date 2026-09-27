# Sample artifacts

Pre-generated `.rfd` files, produced by the sample React app in
`../sample-react-app`, used for the Figma plugin's own import tests so
plugin development doesn't require running the full capture pipeline
every time.

- `SessionCard.demo.rfd` — a real exported artifact for `SessionCard`,
  captured with variants and nested `Avatar`/`Badge` instances. Useful
  as a quick way to try `packages/figma-plugin`'s import without running
  a capture yourself.

To generate your own, run the pipeline against `../sample-react-app`
(see the root README's Quick Start) and export with
`export_design_artifact`.
