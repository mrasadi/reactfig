# ADR 0003: Figma plugin split between iframe UI and sandboxed main thread

## Status
Accepted

## Context
The original brief assumed the plugin's "backend" logic could load a file
from disk, unzip it, and validate it directly. The Figma Plugin API's main
thread (`code.ts`) runs in a sandboxed QuickJS-like environment: it has
**no** `File`/`FileReader` API, no filesystem access, and no `fetch` to
arbitrary origins without an explicit manifest network allowlist. The plugin
UI (`ui.tsx`), by contrast, renders in a real iframe with normal browser
APIs, but has no access to `figma.*` — it can only communicate with the main
thread via `postMessage`.

## Decision
Split responsibilities:

- **`ui.tsx`** (iframe): file picker (`<input type="file">`), reads the
  `.rfd` zip via the File API, unzips with JSZip, parses `manifest.json` and
  `ir.json`, validates against the IR JSON Schema, renders the
  component-selection UI, and `postMessage`s the validated IR (plus decoded
  asset bytes) to the main thread.
- **`code.ts`** (sandboxed main thread): receives only pre-validated data,
  calls `figma.loadFontAsync` for every font before creating/editing text,
  walks the IR and creates native nodes (`FrameNode`, `TextNode`, etc.),
  builds component sets via `figma.combineAsVariants`, and decodes image
  bytes via `figma.createImage`. It never touches the network or filesystem.

## Rationale
This isn't a stylistic choice — it's the only architecture the Plugin API
sandbox permits. Getting this wrong would mean discovering, mid-Phase-6,
that the "backend" code can't actually open the file the UI told it to
import.

## Consequences
- Import is entirely local: no network calls at import time, consistent
  with the no-Figma-MCP / local-first requirement.
- Font availability is a real failure mode: if a referenced font isn't
  installed in the user's Figma, `code.ts` must fall back to a default
  (Inter) and surface a warning rather than throwing.
- The manifest (`manifest.json` for the *plugin itself*, not to be confused
  with the artifact's `manifest.json`) needs no network permissions at all
  for v1, since import doesn't require them.
