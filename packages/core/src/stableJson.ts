/**
 * Deterministic JSON serialization — the single project-wide convention for
 * "write JSON to disk in a way that byte-identical inputs always produce
 * byte-identical output". Sorts object keys at every nesting level so the
 * text is stable regardless of the runtime object key order (which JS does
 * not guarantee for non-integer string keys).
 *
 * Lives in `@reactfig/core` — the package every other one already depends
 * on — rather than being duplicated: `@reactfig/artifact`'s pack() used to
 * carry a private copy of exactly this (docs/adr/0009-artifact-format.md,
 * "Determinism"), and the new checkpoint layer (see
 * packages/mcp/src/checkpoint.ts) needs the same guarantee for its
 * on-disk JSON. One implementation, imported by both, keeps "deterministic
 * JSON" meaning the same thing everywhere.
 *
 * Preserves `generatedAt` and any other nondeterministic *values* the caller
 * put in the data — this only normalizes key ORDER, never values.
 */

/** Sort object keys recursively at every level so JSON.stringify output is stable. */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

/** Deterministic, pretty (2-space) JSON: sorted keys at every level. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2);
}

/**
 * Parses a previously stableStringify'd JSON string back into a plain
 * structural object. Round-trips losslessly for plain JSON data (numbers,
 * strings, booleans, null, arrays, nested objects) — the exact invariant
 * the checkpoint layer relies on: write with stableStringify, read back
 * with stableParse, and get a structurally identical object.
 *
 * Throws on malformed input rather than returning a partial object — a
 * checkpoint that can't be read back is a real failure the caller must
 * surface, not something to swallow.
 */
export function stableParse(text: string): unknown {
  return JSON.parse(text);
}
