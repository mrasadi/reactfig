const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
]);

/**
 * Parses a CSS `font-family` computed-style value (as captured verbatim in
 * `ElementEvidence.style.typography.fontFamily` — see evidence/types.ts)
 * down to the single family name a Figma `FontName.family` lookup needs.
 *
 * getComputedStyle always returns the full author-specified fallback list
 * exactly as written (e.g. `Inter, "Segoe UI", system-ui, sans-serif`),
 * never a single resolved name — there is no browser-side concept of
 * "which of these is actually installed". Figma's font API has no
 * fallback-list form: `loadFontAsync` takes one exact family name and
 * throws if it isn't available in that file, so handing it the raw CSS
 * stack fails for virtually every real page (see
 * packages/figma-plugin/src/code/render/typography.ts's fallback-to-Inter
 * warning). This picks the first *specific* (non-generic-keyword) name
 * in the stack, on the assumption that whoever authored the CSS listed
 * their actually-intended font first — the same assumption every browser
 * makes when choosing among installed fonts.
 *
 * Each entry may be quoted (`"Segoe UI"`, `'Segoe UI'`) or bare
 * (`Inter`); quotes are stripped either way since Figma family names
 * never include them. Generic keywords (`sans-serif`, `system-ui`, ...)
 * are skipped when a specific name is available earlier or later in the
 * list, since none of them name a real installable font. If the entire
 * stack is generic keywords (or empty/unparseable), returns `null` so
 * the caller can fall back to its own default rather than this function
 * guessing one.
 */
export function parseFontFamily(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const entries = raw
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, "").trim())
    .filter(Boolean);
  const specific = entries.find((entry) => !GENERIC_FAMILIES.has(entry.toLowerCase()));
  return specific ?? null;
}
