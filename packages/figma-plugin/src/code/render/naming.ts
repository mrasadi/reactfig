/**
 * Figma infers a ComponentSet's variant properties entirely from each
 * child ComponentNode's name, in "Property=Value, Property2=Value2" form
 * — there is no separate structured API for this (see
 * docs/figma-plugin/feasibility.md, ComponentSet row). Commas and equals
 * signs inside a value would break that parse, so they're sanitized.
 */
export function sanitizeVariantToken(value: string): string {
  return value.replace(/[,=]/g, "-");
}

/**
 * `propertyOrder` MUST come from the owning ComponentSet's
 * `variantProperties` array (ordered, array order survives JSON
 * round-trips) — NOT derived from `Object.keys(propertyValues)`.
 * `@reactfig/artifact`'s `pack()` deterministically re-serializes every
 * object with alphabetically-sorted keys (see ADR 0009); an object's own
 * key iteration order is not guaranteed to survive a pack/unpack
 * round-trip, but Figma's variant-name parsing IS order-sensitive. This
 * was caught by `test/artifactIntegration.test.ts` producing
 * "size=large, variant=primary" (alphabetical, wrong) instead of
 * "variant=primary, size=large" (declared order) after a real pack/unpack
 * round-trip — a genuine cross-phase bug, not a hypothetical one.
 */
export function variantNodeName(propertyValues: Record<string, string>, propertyOrder: string[]): string {
  return propertyOrder
    .filter((name) => name in propertyValues)
    .map((name) => `${sanitizeVariantToken(name)}=${sanitizeVariantToken(propertyValues[name])}`)
    .join(", ");
}
