import {
  Node,
  type SourceFile,
  type ArrayLiteralExpression,
  type VariableDeclaration,
  type ArrowFunction,
  type FunctionExpression,
} from "ts-morph";
import { discoverVariantCaptures, type VariantCaptureCandidate } from "./discoverVariantCaptures.js";

/**
 * Statically discovers `.map()` list-rendering patterns in a component's
 * source and the array literal each one iterates over, so a caller can
 * build per-instance content (see docs/adr/0018-instance-content-overrides.md)
 * without a human manually re-typing every StatCard/SessionCard's real
 * values by hand.
 *
 * Motivating bug: when the pipeline has no way to discover that `STATS`
 * (three different `{label, value, tone}` objects) backs three separate
 * `<StatCard>` instances, every StatCard collapses onto whichever single
 * capture the analyzer happened to take — "12 / Sessions this week"
 * repeated three times instead of 12/6.8/1. Same story for SessionCard and
 * `Amir Hosseini` repeated instead of Amir/Sara/Dana. This module only
 * *discovers* the data; turning it into instance overrides is the caller's
 * job (see Run.md step 2).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MappedItemField {
  /** JSX prop name this field ends up as, e.g. "label", "learnerName", "status". */
  propertyName: string;
  valueKind: "literal" | "template" | "spread";
  /** Raw source text of the JSX expression that produced this field, when there was an explicit one (e.g. "{stat.label}"). Absent for fields only known via a `{...item}` spread. */
  valueSource?: string;
}

export interface MappedDataSource {
  /** e.g. "STATS", "SESSIONS" */
  variableName: string;
  /** Trimmed source of the const array declaration (the whole `const X = [...]` statement). */
  arrayLiteralSource: string;
  /** Best-effort parsed item objects — string/number/boolean/null literals only, `as const` unwrapped. */
  items: Array<Record<string, unknown>>;
}

export interface MappedComponentUsage {
  /** e.g. "StatCard", "SessionCard" */
  componentTag: string;
  /** File that contains the .map() call. */
  parentFile: string;
  /** e.g. "STATS" or "SESSIONS" — the identifier being .map()'d over. */
  dataVariableName: string;
  /** Callback parameter name, e.g. "stat" or "session" — extracted from .map((item) => ...). */
  mapCallbackParamName: string;
  /** True if the JSX has a `{...item}` spread pattern. */
  spreadAttributes: boolean;
  /** Which JSX props come from the array item — via `{...item}` spread and/or an explicit `item.field` expression — and which item field they read. */
  mappedKeys: Array<{ field: MappedItemField; keyInItem: string }>;
  /** The const arrays found in the same file (not just the one this usage maps over) — the caller matches by dataVariableName. */
  dataSources: MappedDataSource[];
  /**
   * Deterministically discovered variant-capture candidates for this
   * component — see `discoverVariantCaptures`. Empty when nothing about
   * this usage looks like a meaningful visual variant (most components):
   * no prop with more than one distinct, enum-like value across the
   * mapped instances.
   */
  variantAxisFields: string[];
  variantCandidates: VariantCaptureCandidate[];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function extractMappedDataRefs(sourceFile: SourceFile): MappedComponentUsage[] {
  const dataSources = collectDataSources(sourceFile);
  const dataSourcesByName = new Map(dataSources.map((d) => [d.variableName, d]));

  const usages: MappedComponentUsage[] = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const callee = node.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "map") return;

    const dataVariableName = callee.getExpression().getText().trim();

    const callback = node.getArguments()[0];
    if (!callback || !(Node.isArrowFunction(callback) || Node.isFunctionExpression(callback))) return;

    const paramNode = callback.getParameters()[0];
    if (!paramNode) return;
    const mapCallbackParamName = paramNode.getNameNode().getText();

    const returnedJsx = findReturnedJsx(callback);
    if (!returnedJsx) return;

    const opening = Node.isJsxSelfClosingElement(returnedJsx)
      ? returnedJsx
      : Node.isJsxElement(returnedJsx)
        ? returnedJsx.getOpeningElement()
        : null;
    if (!opening) return;

    const componentTag = opening.getTagNameNode().getText();
    if (!/^[A-Z]/.test(componentTag)) return; // filter out .map() calls whose JSX root isn't a component (e.g. <li>)

    const matchedDataSource = dataSourcesByName.get(dataVariableName);

    let spreadAttributes = false;
    const mappedKeys: MappedComponentUsage["mappedKeys"] = [];
    const seenPropertyNames = new Set<string>();

    for (const attr of opening.getAttributes()) {
      if (Node.isJsxSpreadAttribute(attr)) {
        if (attr.getExpression().getText().trim() === mapCallbackParamName) {
          spreadAttributes = true;
          // A spread copies every field of the mapped item onto JSX props of the same name.
          for (const key of Object.keys(matchedDataSource?.items[0] ?? {})) {
            if (seenPropertyNames.has(key)) continue;
            seenPropertyNames.add(key);
            mappedKeys.push({ field: { propertyName: key, valueKind: "literal" }, keyInItem: key });
          }
        }
        continue;
      }

      if (!Node.isJsxAttribute(attr)) continue;
      const attrName = attr.getNameNode().getText();
      const init = attr.getInitializer();
      if (!init || !Node.isJsxExpression(init)) continue;
      const expr = init.getExpression();
      if (!expr) continue;

      const rawSource = `{${expr.getText()}}`;

      // `key={stat.label}` / `{...}` on a direct `item.field` access.
      if (Node.isPropertyAccessExpression(expr) && expr.getExpression().getText().trim() === mapCallbackParamName) {
        const keyInItem = expr.getName();
        const isLiteralField = matchedDataSource ? isLiteralValue(matchedDataSource.items[0]?.[keyInItem]) : false;
        seenPropertyNames.add(attrName);
        mappedKeys.push({
          field: { propertyName: attrName, valueKind: isLiteralField ? "literal" : "template", valueSource: rawSource },
          keyInItem,
        });
        continue;
      }

      // A genuine JS template literal referencing the item, e.g. `` `stat-card-${stat.tone}` ``.
      if (Node.isTemplateExpression(expr)) {
        const span = expr.getTemplateSpans().find((s) => s.getExpression().getText().includes(`${mapCallbackParamName}.`));
        if (span) {
          const accessExpr = span.getExpression();
          const keyInItem = Node.isPropertyAccessExpression(accessExpr) ? accessExpr.getName() : accessExpr.getText();
          seenPropertyNames.add(attrName);
          mappedKeys.push({
            field: { propertyName: attrName, valueKind: "template", valueSource: rawSource },
            keyInItem,
          });
        }
      }
    }

    const usage: MappedComponentUsage = {
      componentTag,
      parentFile: sourceFile.getFilePath(),
      dataVariableName,
      mapCallbackParamName,
      spreadAttributes,
      mappedKeys,
      dataSources,
      variantAxisFields: [],
      variantCandidates: [],
    };
    const discovered = discoverVariantCaptures(usage);
    usage.variantAxisFields = discovered.axisFields;
    usage.variantCandidates = discovered.candidates;
    usages.push(usage);
  });

  return usages;
}

// ---------------------------------------------------------------------------
// Data source (const array) collection
// ---------------------------------------------------------------------------

function collectDataSources(sourceFile: SourceFile): MappedDataSource[] {
  const sources: MappedDataSource[] = [];

  for (const stmt of sourceFile.getVariableStatements()) {
    for (const decl of stmt.getDeclarations()) {
      const arrayLiteral = unwrapToArrayLiteral(decl);
      if (!arrayLiteral) continue;

      sources.push({
        variableName: decl.getName(),
        arrayLiteralSource: stmt.getText().trim(),
        items: arrayLiteral.getElements().map(parseObjectLiteralItem).filter((item): item is Record<string, unknown> => item !== null),
      });
    }
  }

  return sources;
}

function unwrapToArrayLiteral(decl: VariableDeclaration): ArrayLiteralExpression | null {
  const init = decl.getInitializer();
  if (!init) return null;
  const unwrapped = Node.isAsExpression(init) ? init.getExpression() : init;
  return Node.isArrayLiteralExpression(unwrapped) ? unwrapped : null;
}

function parseObjectLiteralItem(el: Node): Record<string, unknown> | null {
  const unwrapped = Node.isAsExpression(el) ? el.getExpression() : el;
  if (!Node.isObjectLiteralExpression(unwrapped)) return null;

  const record: Record<string, unknown> = {};
  for (const prop of unwrapped.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) continue; // no evaluation of shorthand/spread/computed props — literal objects only
    const name = prop.getName();
    const value = prop.getInitializer();
    if (!value) continue;
    record[name] = parseLiteralValue(value);
  }
  return record;
}

function parseLiteralValue(node: Node): unknown {
  const unwrapped = Node.isAsExpression(node) ? node.getExpression() : node;

  if (Node.isStringLiteral(unwrapped) || Node.isNoSubstitutionTemplateLiteral(unwrapped)) return unwrapped.getLiteralValue();
  if (Node.isNumericLiteral(unwrapped)) return unwrapped.getLiteralValue();
  if (unwrapped.getKind() === 110 /* TrueKeyword */) return true;
  if (unwrapped.getKind() === 95 /* FalseKeyword */) return false;
  if (unwrapped.getKind() === 106 /* NullKeyword */) return null;

  // Not a literal we evaluate (e.g. an identifier, call, or nested object) — keep the raw source text
  // rather than silently dropping the field. Not evaluated per the module's AST-only scope.
  return unwrapped.getText();
}

function isLiteralValue(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null;
}

// ---------------------------------------------------------------------------
// JSX return-value walking (same pattern as inspectComponentSource.ts's findReturnedJsx)
// ---------------------------------------------------------------------------

function findReturnedJsx(fn: ArrowFunction | FunctionExpression): Node | null {
  const body = fn.getBody();
  if (!body) return null;

  const unwrappedBody = unwrapParens(body);
  if (isJsxLike(unwrappedBody)) return unwrappedBody;

  if (Node.isBlock(body)) {
    for (const stmt of body.getStatements()) {
      if (Node.isReturnStatement(stmt)) {
        const expr = stmt.getExpression();
        if (expr && isJsxLike(unwrapParens(expr))) return unwrapParens(expr);
      }
    }
  }
  return null;
}

function unwrapParens(node: Node): Node {
  let current = node;
  while (Node.isParenthesizedExpression(current)) {
    current = current.getExpression();
  }
  return current;
}

function isJsxLike(node: Node): node is Node {
  return Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node);
}
