import {
  Project,
  Node,
  ts,
  ModuleResolutionKind,
  type SourceFile,
  type ParameterDeclaration,
  type FunctionDeclaration,
  type ArrowFunction,
  type FunctionExpression,
} from "ts-morph";

type ComponentFunctionNode = FunctionDeclaration | ArrowFunction | FunctionExpression;
import type { ComponentSourceEvidence, PropEvidence, JsxOutlineNode, ImportedComponentRef } from "../evidence/types.js";
import { detectPortalUsage } from "./detectPortalUsage.js";

/**
 * No tsconfig is loaded (see `inspectComponentSource`'s use of
 * `skipAddingFilesFromTsConfig`), so ts-morph's module resolution otherwise
 * defaults to classic-style resolution. That default can't follow the
 * `import { Foo } from "./Foo.js"` pattern for a `.tsx`/`.ts` source file —
 * the standard under `"moduleResolution": "nodenext"` for ESM TypeScript
 * projects (this project included — see examples/sample-react-app), and
 * required for `resolveDeclaringFile` below to find anything at all. Module
 * is paired with it because NodeNext's per-file ESM/CJS format detection
 * (which affects resolution) keys off both.
 */
export const RESOLUTION_COMPILER_OPTIONS = {
  moduleResolution: ModuleResolutionKind.NodeNext,
  module: ts.ModuleKind.NodeNext,
};

/**
 * Static prop-type analysis is inherently limited: it resolves a typed,
 * destructured (or single `props`) first parameter — the overwhelmingly
 * common React pattern. It does NOT resolve `React.FC<Props>` generic
 * typing, props assembled via spreads from hooks, or conditional/generic
 * component types. This is a deliberate v1 scope limit, not an oversight:
 * DOM/computed-style evidence remains authoritative for what actually
 * rendered regardless of whether prop typing was resolvable, and prop
 * evidence is only ever used as corroborating signal (e.g. variant-axis
 * candidates), never as ground truth for geometry.
 */
const UNSUPPORTED_PROP_PATTERN_NOTE =
  "Prop type could not be statically resolved (e.g. React.FC<...> generic typing, spread props). Returned with an empty props list — this is a known v1 limitation, not a crash.";

export interface InspectSourceOptions {
  /** Which exported component to inspect. If omitted, the first capitalized named export is used. */
  exportName?: string;
}

export function inspectComponentSource(filePath: string, options: InspectSourceOptions = {}): ComponentSourceEvidence {
  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: RESOLUTION_COMPILER_OPTIONS,
  });
  const sourceFile = project.addSourceFileAtPath(filePath);
  return inspectComponentSourceFromFile(sourceFile, options);
}

/** Same as `inspectComponentSource` but takes an already-loaded SourceFile — used by tests to inspect in-memory fixtures. */
export function inspectComponentSourceFromFile(
  sourceFile: SourceFile,
  options: InspectSourceOptions = {}
): ComponentSourceEvidence {
  const filePath = sourceFile.getFilePath();
  const { name, fn } = findComponent(sourceFile, options.exportName);

  const param = fn.getParameters()[0];
  const props = param ? extractProps(param) : [];

  const jsx = findReturnedJsx(fn);
  const jsxOutline = jsx ? walkJsx(jsx) : null;
  const importedComponents = jsxOutline ? resolveImportedComponents(sourceFile, jsxOutline) : [];

  return {
    file: filePath,
    exportName: name,
    props,
    jsx: jsxOutline,
    importedComponents,
    usesPortal: detectPortalUsage(fn),
  };
}

// ---------------------------------------------------------------------------
// Finding the component declaration
// ---------------------------------------------------------------------------

function findComponent(sourceFile: SourceFile, exportName?: string): { name: string; fn: ComponentFunctionNode } {
  const exported = sourceFile.getExportedDeclarations();

  let name = exportName;
  if (!name) {
    for (const candidate of exported.keys()) {
      if (/^[A-Z]/.test(candidate)) {
        name = candidate;
        break;
      }
    }
  }
  if (!name) {
    throw new Error(`inspectComponentSource: no capitalized exported declaration found in ${sourceFile.getFilePath()}`);
  }

  const decls = exported.get(name);
  if (!decls || decls.length === 0) {
    throw new Error(`inspectComponentSource: export "${name}" not found in ${sourceFile.getFilePath()}`);
  }

  for (const decl of decls) {
    if (Node.isFunctionDeclaration(decl)) return { name, fn: decl };
    if (Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        return { name, fn: init };
      }
    }
  }

  throw new Error(
    `inspectComponentSource: export "${name}" is not a recognized function-component form (function declaration or arrow/function expression). ${UNSUPPORTED_PROP_PATTERN_NOTE}`
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

function extractProps(param: ParameterDeclaration): PropEvidence[] {
  const type = param.getType();
  const properties = type.getProperties();
  if (properties.length === 0) return [];

  const defaults = extractDestructuredDefaults(param);

  return properties.map((sym) => {
    const propType = sym.getTypeAtLocation(param);
    const name = sym.getName();
    const required = !sym.isOptional();
    const isEventHandler = /^on[A-Z]/.test(name);
    const tsType = propType.getText();

    let literalValues: string[] | undefined;
    if (propType.isUnion()) {
      const members = propType.getUnionTypes();
      if (members.length > 0 && members.every((m) => m.isStringLiteral())) {
        literalValues = members.map((m) => String(m.getLiteralValue()));
      }
    } else if (propType.isStringLiteral()) {
      literalValues = [String(propType.getLiteralValue())];
    }

    const evidence: PropEvidence = { name, tsType, required, isEventHandler };
    if (literalValues) evidence.literalValues = literalValues;
    if (defaults[name] !== undefined) evidence.defaultValue = defaults[name];
    return evidence;
  });
}

/** Pulls `{ variant = 'primary' }` style defaults from the parameter's destructuring pattern, if any. */
function extractDestructuredDefaults(param: ParameterDeclaration): Record<string, string> {
  const nameNode = param.getNameNode();
  const defaults: Record<string, string> = {};
  if (!Node.isObjectBindingPattern(nameNode)) return defaults;

  for (const el of nameNode.getElements()) {
    const init = el.getInitializer();
    if (!init) continue;
    const propName = (el.getPropertyNameNode() ?? el.getNameNode()).getText();
    defaults[propName] = init.getText();
  }
  return defaults;
}

// ---------------------------------------------------------------------------
// JSX outline
// ---------------------------------------------------------------------------

function findReturnedJsx(fn: ComponentFunctionNode): Node | null {
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

function isJsxLike(node: Node): boolean {
  return Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node) || Node.isJsxFragment(node);
}

function walkJsx(node: Node): JsxOutlineNode | null {
  const unwrapped = unwrapParens(node);

  if (Node.isJsxElement(unwrapped)) {
    const opening = unwrapped.getOpeningElement();
    return {
      tag: opening.getTagNameNode().getText(),
      attributes: extractJsxAttributes(opening.getAttributes()),
      children: unwrapped
        .getJsxChildren()
        .map(walkJsx)
        .filter((c): c is JsxOutlineNode => c !== null),
    };
  }

  if (Node.isJsxSelfClosingElement(unwrapped)) {
    return {
      tag: unwrapped.getTagNameNode().getText(),
      attributes: extractJsxAttributes(unwrapped.getAttributes()),
      children: [],
    };
  }

  if (Node.isJsxFragment(unwrapped)) {
    return {
      tag: "Fragment",
      attributes: {},
      children: unwrapped
        .getJsxChildren()
        .map(walkJsx)
        .filter((c): c is JsxOutlineNode => c !== null),
    };
  }

  if (Node.isJsxExpression(unwrapped)) {
    const expr = unwrapped.getExpression();
    if (!expr) return null; // empty {} — e.g. a comment-only expression container
    const unwrappedExpr = unwrapParens(expr);
    if (isJsxLike(unwrappedExpr)) return walkJsx(unwrappedExpr);

    // `items.map(item => <Card {...item} />)` — the standard list-rendering
    // pattern. Without unwrapping this, every component only ever rendered
    // inside a `.map()` (any repeated card/row/list-item — exactly how this
    // outline is reached for components like SessionCard/StatCard) is
    // invisible to the outline, and in turn to resolveImportedComponents,
    // even though it's a direct, static child.
    if (Node.isCallExpression(unwrappedExpr)) {
      const callback = unwrappedExpr.getArguments()[0];
      if (callback && (Node.isArrowFunction(callback) || Node.isFunctionExpression(callback))) {
        const returnedJsx = findReturnedJsx(callback);
        if (returnedJsx) return walkJsx(returnedJsx);
      }
    }

    // `condition && <Banner />` — common conditional-render guard.
    if (Node.isBinaryExpression(unwrappedExpr) && unwrappedExpr.getOperatorToken().getText() === "&&") {
      const right = unwrapParens(unwrappedExpr.getRight());
      if (isJsxLike(right)) return walkJsx(right);
    }

    // `condition ? <A /> : <B />` — only one branch renders at a time, so (like
    // the existing single-child outline shape generally) we surface one:
    // whichever branch is JSX, preferring the "true" branch when both are.
    // A caller that needs the alternate branch's own composition can inspect
    // it separately; recording neither, when either is real JSX, would be worse.
    if (Node.isConditionalExpression(unwrappedExpr)) {
      const whenTrue = unwrapParens(unwrappedExpr.getWhenTrue());
      const whenFalse = unwrapParens(unwrappedExpr.getWhenFalse());
      if (isJsxLike(whenTrue)) return walkJsx(whenTrue);
      if (isJsxLike(whenFalse)) return walkJsx(whenFalse);
    }

    return { tag: "Expression", attributes: {}, children: [] };
  }

  if (Node.isJsxText(unwrapped)) {
    const text = unwrapped.getText().trim();
    if (!text) return null;
    return { tag: "Text", attributes: { value: text }, children: [] };
  }

  return null;
}

function extractJsxAttributes(attrs: Node[]): Record<string, string | true> {
  const result: Record<string, string | true> = {};
  for (const attr of attrs) {
    if (!Node.isJsxAttribute(attr)) continue; // skip spread attributes {...props}
    const name = attr.getNameNode().getText();
    const init = attr.getInitializer();
    if (!init) {
      result[name] = true; // boolean shorthand, e.g. `disabled`
      continue;
    }
    if (Node.isStringLiteral(init)) {
      result[name] = init.getLiteralValue();
      continue;
    }
    if (Node.isJsxExpression(init)) {
      const expr = init.getExpression();
      if (expr && Node.isStringLiteral(expr)) {
        result[name] = expr.getLiteralValue();
        continue;
      }
    }
    result[name] = true; // dynamic value — presence recorded, value not statically known
  }
  return result;
}

// ---------------------------------------------------------------------------
// Imported component resolution
// ---------------------------------------------------------------------------

function collectCapitalizedTags(node: JsxOutlineNode, into: Set<string>): void {
  if (/^[A-Z]/.test(node.tag)) into.add(node.tag);
  for (const child of node.children) collectCapitalizedTags(child, into);
}

function resolveImportedComponents(sourceFile: SourceFile, jsxOutline: JsxOutlineNode): ImportedComponentRef[] {
  const tags = new Set<string>();
  collectCapitalizedTags(jsxOutline, tags);
  if (tags.size === 0) return [];

  const project = sourceFile.getProject();
  const result: ImportedComponentRef[] = [];
  for (const imp of sourceFile.getImportDeclarations()) {
    const moduleSpecifier = imp.getModuleSpecifierValue();
    for (const named of imp.getNamedImports()) {
      const localName = named.getAliasNode()?.getText() ?? named.getName();
      if (!tags.has(localName)) continue;
      const ref: ImportedComponentRef = { name: localName, moduleSpecifier };
      const target = resolveDeclaringFile(project, sourceFile, moduleSpecifier, named.getName());
      if (target) ref.resolvedFile = target.file;
      result.push(ref);
    }
    const def = imp.getDefaultImport();
    if (def && tags.has(def.getText())) {
      const ref: ImportedComponentRef = { name: def.getText(), moduleSpecifier };
      const target = resolveDeclaringFile(project, sourceFile, moduleSpecifier, "default");
      if (target) ref.resolvedFile = target.file;
      result.push(ref);
    }
  }
  return result;
}

/**
 * Follows an import to the file that actually declares the named export,
 * walking through any barrel / re-export chain in between (`moduleSpecifier`
 * alone only tells you the module immediately imported from, which may just
 * be an `index.ts` that re-exports from elsewhere).
 *
 * Deliberately does its own module resolution via `ts.resolveModuleName`
 * rather than relying on ts-morph's symbol/alias machinery
 * (`identifier.getSymbol().getAliasedSymbol()`): that path silently fails to
 * resolve the `import { Foo } from "./Foo.js"` extension-swapping pattern
 * (`.js` specifier, `.tsx` file) that NodeNext-style ESM projects use —
 * including this one, examples/sample-react-app — leaving every such import
 * unresolved even though `ts.resolveModuleName` itself handles it fine.
 * `getExportedDeclarations()` on the resolved file is what actually follows
 * a barrel's re-export chain to the real declaring file, same as
 * `findComponent` above already relies on for the entry file itself.
 *
 * Returns undefined when the specifier doesn't resolve to a project source
 * file at all — an external package, a path this resolver can't settle, or
 * (heuristically, by path) something living in node_modules — or when the
 * resolved file doesn't actually export that name (e.g. a default-import
 * mismatch). In every such case the caller already has what it needs from
 * `moduleSpecifier` on the returned ref; this only adds detail when there's
 * project source to actually walk into.
 */
function resolveDeclaringFile(
  project: Project,
  containingFile: SourceFile,
  moduleSpecifier: string,
  exportedName: string,
  seen: Set<string> = new Set()
): { file: string; exportName: string } | undefined {
  let resolution: ts.ResolvedModuleWithFailedLookupLocations;
  try {
    resolution = ts.resolveModuleName(moduleSpecifier, containingFile.getFilePath(), project.getCompilerOptions(), ts.sys);
  } catch {
    return undefined; // resolution host threw (e.g. a malformed specifier) — nothing further to add, moduleSpecifier alone still stands
  }

  const resolved = resolution.resolvedModule;
  if (!resolved || resolved.isExternalLibraryImport) return undefined;
  if (resolved.resolvedFileName.includes("/node_modules/")) return undefined; // don't try to walk into library internals as if they were app components

  const cycleKey = `${resolved.resolvedFileName}::${exportedName}`;
  if (seen.has(cycleKey)) return undefined; // a re-export cycle — nothing further to add, not a crash
  seen.add(cycleKey);

  const targetSourceFile = project.addSourceFileAtPathIfExists(resolved.resolvedFileName);
  if (!targetSourceFile) return undefined;

  // The common case: the target file declares this export itself (a real
  // component file), or ts-morph's checker already fully resolved a
  // re-export chain that runs through files already in the project.
  const decls = targetSourceFile.getExportedDeclarations().get(exportedName);
  if (decls && decls.length > 0) {
    return { file: decls[0].getSourceFile().getFilePath(), exportName: exportedName };
  }

  // Otherwise, walk `export ... from "./other.js"` declarations by hand —
  // `getExportedDeclarations()` above can come back empty for a re-export
  // whose ultimate source file isn't part of the project's already-resolved
  // set yet (e.g. a components/index.ts barrel: ts-morph doesn't eagerly
  // walk `export { X } from "./X.js"` targets just because the barrel
  // itself was added), which is exactly the barrel case this function
  // exists to handle, so falling back to a plain wrong answer isn't
  // acceptable here the way it is for the other "nothing further to add"
  // returns above.
  for (const exportDecl of targetSourceFile.getExportDeclarations()) {
    const reExportSpecifier = exportDecl.getModuleSpecifierValue();
    if (!reExportSpecifier) continue; // a local `export { x }`, not a re-export — nothing to follow

    const namedExports = exportDecl.getNamedExports();
    if (namedExports.length === 0) {
      // `export * from "./other.js"` — re-exports everything under its original name.
      const nested = resolveDeclaringFile(project, targetSourceFile, reExportSpecifier, exportedName, seen);
      if (nested) return nested;
      continue;
    }
    for (const named of namedExports) {
      const exposedAs = named.getAliasNode()?.getText() ?? named.getName();
      if (exposedAs !== exportedName) continue;
      const nested = resolveDeclaringFile(project, targetSourceFile, reExportSpecifier, named.getName(), seen);
      if (nested) return nested;
    }
  }

  return undefined;
}
