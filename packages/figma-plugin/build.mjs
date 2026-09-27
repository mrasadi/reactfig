import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
mkdirSync(`${root}dist`, { recursive: true });

// Sandbox code — runs in Figma's restricted plugin runtime, not a browser.
// No DOM assumptions belong here (see src/code/*).
await build({
  entryPoints: [`${root}src/code/index.ts`],
  outfile: `${root}dist/code.js`,
  bundle: true,
  format: "iife",
  target: "es2017",
  platform: "browser", // closest esbuild platform to the sandbox's JS-only environment; no Node builtins are used in src/code
});

// UI bundle — a real browser iframe. Figma's manifest.ui field must point
// to a single HTML file with everything inlined (no external script/link
// tags), so JS and CSS are built separately then spliced into the template.
await build({
  entryPoints: [`${root}src/ui/main.tsx`],
  outfile: `${root}dist/ui.bundle.js`,
  bundle: true,
  format: "iife",
  target: "es2020",
  platform: "browser",
  jsx: "automatic",
  loader: { ".css": "css" },
});

let js = readFileSync(`${root}dist/ui.bundle.js`, "utf-8");
const css = readFileSync(`${root}dist/ui.bundle.css`, "utf-8");
const template = readFileSync(`${root}src/ui/ui.template.html`, "utf-8");

// Escape </script> in the JS bundle to prevent HTML injection.
// Bundled dependencies (e.g., ajv → fast-uri) may contain literal "</script" strings
// that would prematurely close the <script> tag in the HTML template, causing
// the browser to render remaining JS as visible text.
js = js.replace(/<\/script/gi, "<\\/script");

// Use a function replacer (not a string) so that "$&", "$1", "$$", etc. in the
// bundle are treated literally. String.prototype.replace interprets "$" patterns
// in a string replacement, and the bundle contains literal "$&" (from template
// literals / regexes) which would otherwise be substituted with the matched
// placeholder and corrupt the output.
const html = template
   .replace("/*__CSS__*/", () => css)
   .replace("/*__JS__*/", () => js);

// Regression check: exactly one </script> should exist in the final HTML (the closing tag).
const matches = html.match(/<\/script>/gi);
if (matches && matches.length !== 1) {
  throw new Error(
     `Expected exactly one </script> in generated ui.html, found ${matches?.length ?? 0}. This likely indicates unescaped </script> sequences leaked through the build escaping logic.`
   );
}

writeFileSync(`${root}dist/ui.html`, html);

console.log("Built dist/code.js and dist/ui.html");
