import { posix } from 'node:path';
import ts from 'typescript';

// Source guards for product code: what the boundary lint (dependency-cruiser) cannot see,
// because it only follows static import edges. tests/source-guards.test.ts runs them over
// packages/*/src, except tests, __fixtures__, core/testing and core/fixtures; scripts, tools
// and the root tests are not product code and are not checked.
//
// 1. No module loading the lint cannot follow: a computed import(), require (any use),
//    import = require, a runtime import or literal import() of node:module, module, node:vm
//    or vm under any name (default, named, aliased, namespace), getBuiltinModule in any
//    form, eval, Function, a .constructor(...) call or ['constructor'] (the Function
//    constructor by another name), computed member access on process or globalThis, and
//    any of those names as a string (Reflect.get(process, 'getBuiltinModule')).
// 2. No CommonJS exports: module.exports, exports, export =.
// 3. Bindings imported at runtime from the guarded modules below (the grant issuer, the
//    write pool) may only be called, or have a member called (Authorized.verify(...)); any
//    other use hands them on (export { writer }, export const w = writer, export default
//    writer, { writer }, an argument, a return value), and so does any re-export of a
//    guarded module. Type-only imports and exports are free.

/** Repository paths (without extension) whose runtime bindings must not travel. */
const guardedModules = new Set([
  'packages/core/src/authz/brand',
  'packages/core/src/authz/authorize',
  'packages/core/src/db/write',
  'packages/core/src/db/pools',
]);
/** Module sources product code may not load at runtime at all. */
const forbiddenSources = new Set(['module', 'node:module', 'vm', 'node:vm']);
/** Names that reach a module loader or an evaluator wherever they appear outside a type. */
const forbiddenNames = new Set(['require', 'eval', 'Function', 'getBuiltinModule']);

/** The repository path a specifier names, without extension; undefined for npm and node: specifiers. */
function resolve(file: string, specifier: string): string | undefined {
  const workspace = /^@peblish\/([^/]+)\/(.+)$/.exec(specifier);
  const path = specifier.startsWith('.')
    ? posix.normalize(posix.join(posix.dirname(file), specifier))
    : workspace
      ? `packages/${workspace[1]}/src/${workspace[2]}`
      : undefined;
  return path?.replace(/\.(ts|tsx|js|mjs)$/, '');
}

const isGuarded = (file: string, specifier: string) => guardedModules.has(resolve(file, specifier) ?? '');

/** True inside a type annotation, type alias or interface, where names are erased. */
function inType(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current) || ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current)) return true;
    if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) return false;
  }
  return false;
}

/** The name being declared or a property key, as opposed to a reference to a binding. */
function isDeclarationName(id: ts.Identifier): boolean {
  const parent = id.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === id) ||
    (ts.isQualifiedName(parent) && parent.right === id) ||
    (ts.isLabeledStatement(parent) && parent.label === id) ||
    ((ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isParameter(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isGetAccessor(parent) ||
      ts.isSetAccessor(parent) ||
      ts.isEnumMember(parent) ||
      ts.isBindingElement(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent)) &&
      parent.name === id)
  );
}

/** A guarded reference is allowed only as a callee, or as the object of a called member. */
function isCalled(reference: ts.Expression): boolean {
  const parent = reference.parent;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === reference) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === reference && parent.name.text !== 'bind') {
    return isCalled(parent);
  }
  return false;
}

const literalText = (node: ts.Node | undefined) => (node && ts.isStringLiteralLike(node) ? node.text : undefined);

/** Every guard violation in one product source file, as `what at line N`. */
export function sourceGuardFindings(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const report = (node: ts.Node, what: string) =>
    found.push(`${what} at line ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);

  // Local names bound at runtime to a guarded module: named and default imports, and namespaces.
  const guardedNames = new Map<string, string>();
  const guardedNamespaces = new Map<string, string>();

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const from = literalText(statement.moduleSpecifier) ?? '';
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : [];
      const runtimeNamed = named.filter((element) => !element.isTypeOnly);
      const namespace = clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? clause.namedBindings.name : undefined;
      const runtime = !clause || clause.name || namespace || runtimeNamed.length > 0 || named.length === 0;
      if (forbiddenSources.has(from) && runtime) report(statement, `runtime import of ${from}`);
      if (isGuarded(source.fileName, from)) {
        if (clause?.name) guardedNames.set(clause.name.text, from);
        if (namespace) guardedNamespaces.set(namespace.text, from);
        for (const element of runtimeNamed) guardedNames.set(element.name.text, from);
      }
    }
    if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly) report(statement, 'import = require');
    if (ts.isExportAssignment(statement) && statement.isExportEquals) report(statement, 'export =');
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !statement.isTypeOnly) {
      const from = literalText(statement.moduleSpecifier) ?? '';
      const clause = statement.exportClause;
      const runtime = !clause || ts.isNamespaceExport(clause) || clause.elements.some((element) => !element.isTypeOnly);
      if (runtime && (forbiddenSources.has(from) || isGuarded(source.fileName, from))) report(statement, `re-export of ${from}`);
    }
  }

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const from = literalText(node.arguments[0]);
      if (from === undefined) report(node, 'import() with a computed specifier');
      else if (forbiddenSources.has(from) || isGuarded(source.fileName, from)) report(node, `import() of ${from}`);
    }

    if (ts.isIdentifier(node) && !inType(node)) {
      const name = node.text;
      if (forbiddenNames.has(name)) report(node, `${name}`);
      else if (name === 'exports' && !isDeclarationName(node)) report(node, 'CommonJS exports');
      else if (!isDeclarationName(node)) {
        const from = guardedNames.get(name);
        if (from && ts.isExportSpecifier(node.parent)) {
          if (!node.parent.isTypeOnly && !node.parent.parent.parent.isTypeOnly) report(node, `export of ${name} from ${from}`);
        } else if (from && !isCalled(node)) {
          report(node, `${name} from ${from} used as a value (only calls are allowed)`);
        }
        const namespaceFrom = guardedNamespaces.get(name);
        if (namespaceFrom && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && isCalled(node.parent))) {
          report(node, `namespace ${name} of ${namespaceFrom} used other than to call a member`);
        }
      }
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'module' &&
      node.name.text === 'exports'
    ) {
      report(node, 'CommonJS module.exports');
    }
    // A loader or evaluator named by string: Reflect.get(process, 'getBuiltinModule'), obj['eval'].
    if (
      ts.isStringLiteralLike(node) &&
      (forbiddenNames.has(node.text) || node.text === 'createRequire') &&
      !ts.isImportDeclaration(node.parent)
    ) {
      report(node, `the string ${JSON.stringify(node.text)}`);
    }
    if (ts.isElementAccessExpression(node)) {
      const key = literalText(node.argumentExpression);
      if (key === 'constructor') report(node, '["constructor"]');
      if (
        key === undefined &&
        ts.isIdentifier(node.expression) &&
        (node.expression.text === 'process' || node.expression.text === 'globalThis')
      ) {
        report(node, `computed member access on ${node.expression.text}`);
      }
    }
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'constructor'
    ) {
      report(node, '.constructor(...) call');
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
