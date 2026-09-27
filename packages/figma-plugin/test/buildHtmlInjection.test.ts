import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Regression test for the HTML-injection class of bugs in the UI bundle
 * splice (build.mjs). Two independent defects can leak "</script>" (or
 * visible source) into dist/ui.html:
 *
 *  1. A literal "</script>" sequence inside the JS bundle prematurely closes
 *     the <script> tag, so the browser renders the rest as visible text.
 *  2. Using the bundle as a *string* replacement in String.prototype.replace
 *     makes "$&", "$1", "$$", etc. act as substitution patterns — the bundle
 *     contains literal "$&" (from template literals / regexes), which corrupt
 *     the output.
 *
 * The build guards against both: it escapes "</script" and splices via a
 * function replacer. These tests pin that contract.
 */
const root = fileURLToPath(new URL("../", import.meta.url));

// Mirror of the escaping + splice logic in build.mjs.
function buildHtml(template: string, css: string, js: string): string {
  let escapedJs = js.replace(/<\/script/gi, "<\\/script");
  return template
      .replace("/*__CSS__*/", () => css)
      .replace("/*__JS__*/", () => escapedJs);
}

describe("UI bundle HTML injection guards", () => {
  it("exactly one </script> remains after escaping + splicing a clean bundle", () => {
    const template = `<!doctype html><style>/*__CSS__*/</style><script>/*__JS__*/</script>`;
    const css = ".x{color:red}";
    const js = "var x = 1;";
    const html = buildHtml(template, css, js);
    expect(html.match(/<\/script>/gi)).toHaveLength(1);
  });

  it("escapes a literal </script> embedded in the JS bundle", () => {
    const template = `<!doctype html><script>/*__JS__*/</script>`;
    const js = 'var re = /<\\/script/g; var s = "<script></script>";';
    const html = buildHtml(template, "", js);
    // The only literal </script> is the template's closing tag.
    expect(html.match(/<\/script>/gi)).toHaveLength(1);
  });

  it("does not corrupt the splice when the bundle contains $&", () => {
    const template = `<!doctype html><script>/*__JS__*/</script>`;
    // "$&" as a string replacement would inject the matched placeholder
    // ("/*__JS__*/"); a function replacer keeps it literal.
    const js = "const s = \"x$&y\"; const t = a.$replace('$&', 'z');";
    const html = buildHtml(template, "", js);
    expect(html.includes("$&")).toBe(true);
    expect(html.includes("/*__JS__*/")).toBe(false);
    expect(html.match(/<\/script>/gi)).toHaveLength(1);
  });

  it("generated dist/ui.html (if present) has exactly one </script>", () => {
    const outPath = `${root}dist/ui.html`;
    if (!existsSync(outPath)) return; // skip when the build hasn't run
    const html = readFileSync(outPath, "utf-8");
    expect(html.match(/<\/script>/gi)).toHaveLength(1);
  });
});
