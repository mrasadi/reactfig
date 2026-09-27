# @reactfig/core

The Design IR contract: TypeScript types + a JSON Schema for
`design-ir/v1`, plus a validator built on Ajv.

This package has no dependency on Figma, Playwright, or any model provider —
it is the shared vocabulary every other package imports.

Scope for v1 is documented in `docs/adr/0002-design-ir-scope.md` at the repo
root. This package is the implementation target for Phase 2.

Planned contents:
- `src/schema/design-ir.v1.schema.json` — the formal JSON Schema
- `src/types.ts` — matching TypeScript types
- `src/validate.ts` — `validateDesignIR(doc): ValidationResult`
