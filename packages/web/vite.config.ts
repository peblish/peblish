import optimizeLocales from '@react-aria/optimize-locales-plugin';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { nitro } from 'nitro/vite';
import { defineConfig, parseSync, type Plugin, Visitor } from 'vite';

/** The locales the UI ships (src/i18n/negotiate.ts); React Aria's translated strings for any other are dropped from the bundle. */
const locales = ['en-US', 'de-DE'];

// Vendor chunks, named so the payload budget (e2e/payload) can count them exactly: React, Mux UI
// with the React Aria, React Stately and internationalization code it pulls in, and the
// composer's editor (lazy; only the composer route loads it). Nothing else may hold their
// modules: payloadChunks() below records what each chunk contains and the budget check fails
// when a vendor package sits in an app chunk.
const vendorGroups = {
  'vendor-react': /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
  'vendor-mux':
    /[\\/]node_modules[\\/](?:@muxui[\\/]react|react-aria|react-aria-components|react-stately|@react-aria|@react-stately|@react-types|@internationalized|@swc[\\/]helpers|motion|framer-motion|motion-dom|motion-utils|lucide-react|clsx|use-sync-external-store)[\\/]/,
  'vendor-editor':
    /[\\/]node_modules[\\/](?:@tiptap|prosemirror-[\w-]+|orderedmap|rope-sequence|w3c-keyname|crelt|linkifyjs|@remirror)[\\/]|[\\/]@muxui[\\/]react[\\/]generated[\\/]text-editor/,
} as const;

const substrateQuery = '?mux-substrate=';
const substrateHelpers = 'helpers';

const substratePartId = (file: string, part: string) => JSON.stringify(file + substrateQuery + part);

function substrateDrift(file: string, what: string): never {
  throw new Error(
    `peblish:split-mux-substrate: ${what} in ${file}. Mux UI's substrate.js changed shape; update splitMuxSubstrate in vite.config.ts.`,
  );
}

function parseModule(file: string, code: string) {
  const { program, comments, errors } = parseSync(file, code);
  if (errors.length > 0) substrateDrift(file, 'a parse error');
  return { program, comments };
}

const parseProgram = (file: string, code: string) => parseModule(file, code).program;

type Program = ReturnType<typeof parseProgram>;
type Statement = Program['body'][number];
type Expression = Extract<Statement, { type: 'ExpressionStatement' }>['expression'];
type Class = Extract<Expression, { superClass: unknown }>;

/**
 * What a top-level value is known to be, which decides what may be done with it without running code:
 * - primitive: a string, number, boolean, bigint, null or undefined, which an operator converts without a call;
 * - plain: an object or array literal with no accessor and no `__proto__`, whose properties may be read and set;
 * - frozen: Object.freeze of a plain literal, whose properties may be read;
 * - function: a function, or a class with no heritage and no static accessor, whose properties may be read and set;
 * - component: what React's forwardRef or memo returns, whose properties may be set (`Tooltip.displayName = ...`);
 * - namespace: a module namespace, or React, whose exports may be read;
 * - builtin: a global constructor the module does not shadow, which a class may extend;
 * - other: anything else free of effects, which may only be passed along.
 */
type Kind = 'primitive' | 'plain' | 'frozen' | 'function' | 'component' | 'namespace' | 'builtin' | 'other';
const readable = new Set<Kind>(['plain', 'frozen', 'function', 'namespace']);
// A property set on one of these runs no setter but React's, which in development only names the component itself.
const writable = new Set<Kind>(['plain', 'function', 'component']);

// The globals a top-level value may name, unless the module declares a binding of that name.
const builtins = new Map<string, Kind>([
  ['undefined', 'primitive'],
  ['NaN', 'primitive'],
  ['Infinity', 'primitive'],
  ...['Object', 'Set', 'Map', 'WeakSet', 'WeakMap'].map((name) => [name, 'builtin'] as const),
]);
// Calls whose only work is to build a value, beyond those Mux marks /*#__PURE__*/: React's component and context
// factories, Object.freeze of a literal, and the built-in collections, empty or from an array literal.
const pureReactCalls = new Set(['forwardRef', 'memo', 'createContext']);
const collections = new Set(['Set', 'Map', 'WeakSet', 'WeakMap']);

/** Thrown inside assertPureTopLevel at the first node that may run code. */
class Effect {
  readonly node: { start: number; end: number };
  constructor(node: { start: number; end: number }) {
    this.node = node;
  }
}
const effect = (node: { start: number; end: number }): never => {
  throw new Effect(node);
};

/**
 * Fails the build, through `drift` (the split's own error), on the first top-level statement in `code` that may run
 * code when the module loads. A split module's client parts keep only what an import reaches, while the server runs
 * the whole module, so an effect (`const registration = registerOverlay(Tooltip)` that nothing reads) would run on the
 * server and silently not in the browser. The check fails closed: it accepts only what it can prove runs nothing.
 *
 * Accepted values: literals; functions; classes with no decorators, static blocks or computed keys, whose heritage is a
 * function of this module or a builtin and whose static values are accepted; object and array literals of accepted
 * values without spread; reads of an import, of a top-level binding already initialised, or of an unshadowed builtin;
 * member reads on a namespace, React, or a plain, frozen or function binding or literal (none can run a getter), with
 * a primitive computed key; untagged templates, unary and binary operators whose conversions call nothing (their
 * operands are primitive, or the operator is `typeof`, `!`, `void`, `===` or `!==`); logical and conditional
 * expressions; and calls or `new` with accepted callee and arguments that are marked /*#__PURE__*\/, React's
 * forwardRef, memo or createContext, Object.freeze of a plain literal, or a new Set, Map, WeakSet or WeakMap with no
 * argument or an array literal (of array literals, for a map). Everything else is rejected, among it getters reached
 * by a read, `in`, `instanceof`, `delete`, optional chains, tagged templates, assignments, `await`, `import()` and
 * `using`. The one statement accepted beside declarations and imports is a property set, `target.key = value`, on a
 * plain, function or component binding with a literal key other than `__proto__` and an accepted value. Default
 * parameter values and function bodies do not run at definition and are not checked.
 */
function assertPureTopLevel(file: string, code: string, drift: (file: string, what: string) => never) {
  const { program, comments } = parseModule(file, code);
  // A call is marked pure when a /*#__PURE__*/ or /* @__PURE__ */ comment is all that comes before it.
  const pureCalls = new Set(
    comments
      .filter(({ value }) => /^\s*[#@]__PURE__\s*$/.test(value))
      .map(({ end }) => end + (/^\s*/.exec(code.slice(end))?.[0].length ?? 0)),
  );
  // Every top-level name, so a builtin's name counts as the builtin only when the module does not declare it.
  const declared = new Set<string>();
  // What each top-level binding readable so far holds: imports and function declarations from the start, the others
  // once their initialiser has been checked.
  const bindings = new Map<string, Kind>();
  // The local names `react` is imported as (namespace or default), whose factories are pure.
  const react = new Set<string>();
  for (const node of program.body) {
    const declaration = node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration' ? node.declaration : node;
    if (node.type === 'ImportDeclaration')
      for (const specifier of node.specifiers) {
        const whole =
          specifier.type === 'ImportNamespaceSpecifier' || (specifier.type === 'ImportDefaultSpecifier' && node.source.value === 'react');
        if (whole && node.source.value === 'react') react.add(specifier.local.name);
        declared.add(specifier.local.name);
        bindings.set(specifier.local.name, whole ? 'namespace' : 'other');
      }
    else if (declaration?.type === 'FunctionDeclaration' && declaration.id) {
      declared.add(declaration.id.name);
      bindings.set(declaration.id.name, 'function');
    } else if (declaration?.type === 'ClassDeclaration' && declaration.id) declared.add(declaration.id.name);
    else if (declaration?.type === 'VariableDeclaration')
      for (const { id } of declaration.declarations) if (id.type === 'Identifier') declared.add(id.name);
  }
  const builtin = (name: string) => (declared.has(name) ? undefined : builtins.get(name));

  const valueOf = (node: Expression | null | undefined): Kind => {
    if (!node) return 'primitive';
    switch (node.type) {
      case 'Literal':
        return 'regex' in node ? 'other' : 'primitive';
      case 'Identifier':
        return bindings.get(node.name) ?? builtin(node.name) ?? effect(node);
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        return 'function';
      case 'ClassExpression':
        return classOf(node);
      case 'ParenthesizedExpression':
        return valueOf(node.expression);
      case 'TemplateLiteral':
        for (const expression of node.expressions) if (valueOf(expression) !== 'primitive') effect(expression);
        return 'primitive';
      case 'UnaryExpression': {
        if (node.operator === 'delete') return effect(node);
        // `typeof` of an undeclared global throws nothing; of a binding not yet initialised it throws.
        const { argument } = node;
        if (node.operator === 'typeof' && argument.type === 'Identifier' && !declared.has(argument.name)) return 'primitive';
        if (valueOf(argument) !== 'primitive' && ['+', '-', '~'].includes(node.operator)) effect(node);
        return 'primitive';
      }
      case 'BinaryExpression': {
        const { left, operator } = node;
        if (left.type === 'PrivateIdentifier' || operator === 'in' || operator === 'instanceof') return effect(node);
        const operands = [valueOf(left), valueOf(node.right)];
        if (operator !== '===' && operator !== '!==' && operands.some((kind) => kind !== 'primitive')) effect(node);
        return 'primitive';
      }
      case 'LogicalExpression':
        return [valueOf(node.left), valueOf(node.right)].every((kind) => kind === 'primitive') ? 'primitive' : 'other';
      case 'ConditionalExpression': {
        valueOf(node.test);
        const [consequent, alternate] = [valueOf(node.consequent), valueOf(node.alternate)];
        return consequent === alternate ? consequent : 'other';
      }
      case 'MemberExpression':
        if (node.optional || node.object.type === 'Super' || node.property.type === 'PrivateIdentifier') return effect(node);
        if (!readable.has(valueOf(node.object))) effect(node);
        if (node.computed && valueOf(node.property) !== 'primitive') effect(node.property);
        return 'other';
      case 'ArrayExpression':
        for (const element of node.elements) valueOf(element?.type === 'SpreadElement' ? effect(element) : element);
        return 'plain';
      case 'ObjectExpression': {
        let kind: Kind = 'plain';
        for (const property of node.properties) {
          if (property.type === 'SpreadElement') return effect(property);
          const key = property.key as Expression;
          if (property.computed && valueOf(key) !== 'primitive') effect(key);
          valueOf(property.value as Expression);
          // An accessor runs on a read; a `__proto__: value` entry sets the prototype, which may hold accessors.
          const name = key.type === 'Identifier' ? key.name : key.type === 'Literal' ? String(key.value) : undefined;
          if (property.kind !== 'init' || (!property.computed && !property.shorthand && !property.method && name === '__proto__'))
            kind = 'other';
        }
        return kind;
      }
      case 'CallExpression':
      case 'NewExpression': {
        const { callee } = node;
        if ((node.type === 'CallExpression' && node.optional) || callee.type === 'Super') return effect(node);
        const args = node.arguments.map((argument) => (argument.type === 'SpreadElement' ? effect(argument) : argument));
        if (pureCalls.has(node.start)) {
          valueOf(callee);
          args.forEach(valueOf);
          return 'other';
        }
        const [object, property] =
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.object.type === 'Identifier' &&
          callee.property.type === 'Identifier'
            ? [callee.object.name, callee.property.name]
            : [];
        if (node.type === 'CallExpression' && object !== undefined && react.has(object) && pureReactCalls.has(property!)) {
          args.forEach(valueOf);
          return property === 'createContext' ? 'other' : 'component';
        }
        const [first, ...rest] = args;
        if (node.type === 'CallExpression' && object === 'Object' && property === 'freeze' && builtin('Object')) {
          const literal = first?.type === 'ObjectExpression' || first?.type === 'ArrayExpression';
          return literal && rest.length === 0 && valueOf(first) === 'plain' ? 'frozen' : effect(node);
        }
        // A collection iterates its argument, so only an array literal's own iterator may run; a map also reads each
        // entry's 0 and 1, so each entry must be an array literal too.
        if (node.type === 'NewExpression' && callee.type === 'Identifier' && collections.has(callee.name) && builtin(callee.name)) {
          if (rest.length > 0 || (first && first.type !== 'ArrayExpression')) return effect(node);
          const map = callee.name.endsWith('Map');
          for (const entry of first?.elements ?? []) if (map && entry?.type !== 'ArrayExpression') effect(entry ?? node);
          valueOf(first);
          return 'other';
        }
        return effect(node);
      }
      default:
        return effect(node);
    }
  };

  const classOf = (node: Class): Kind => {
    if (node.decorators.length > 0) return effect(node);
    // A subclass inherits its parent's static accessors, so only a class with no heritage is safe to read from.
    let kind: Kind = node.superClass ? 'other' : 'function';
    if (node.superClass && !['function', 'builtin'].includes(valueOf(node.superClass))) effect(node.superClass);
    for (const element of node.body.body) {
      if (element.type === 'StaticBlock' || element.type === 'TSIndexSignature' || element.computed || element.decorators.length > 0)
        return effect(element);
      if (!element.static) continue;
      if (element.type === 'MethodDefinition' || element.type === 'TSAbstractMethodDefinition') {
        if (element.kind === 'get' || element.kind === 'set') kind = 'other';
      } else {
        valueOf(element.value);
        if (element.type !== 'PropertyDefinition') kind = 'other';
      }
    }
    return kind;
  };

  const statement = (node: Statement): void => {
    switch (node.type) {
      case 'ImportDeclaration':
      case 'FunctionDeclaration':
      case 'ExportAllDeclaration':
      case 'EmptyStatement':
        return;
      case 'ExportNamedDeclaration':
        if (node.declaration) statement(node.declaration);
        return;
      case 'ExportDefaultDeclaration': {
        const { declaration } = node;
        if (declaration.type === 'ClassDeclaration') classOf(declaration);
        else if (declaration.type !== 'FunctionDeclaration' && declaration.type !== 'TSInterfaceDeclaration') valueOf(declaration);
        return;
      }
      case 'ClassDeclaration': {
        const kind = classOf(node);
        if (node.id) bindings.set(node.id.name, kind);
        return;
      }
      case 'VariableDeclaration':
        if (node.kind === 'using' || node.kind === 'await using') return effect(node);
        for (const { id, init } of node.declarations) {
          // A pattern reads properties or iterates; a let or var may be reassigned before it is read.
          if (id.type !== 'Identifier') return effect(id);
          const kind = valueOf(init);
          bindings.set(id.name, node.kind === 'const' ? kind : 'other');
        }
        return;
      case 'ExpressionStatement': {
        // Only `target.key = value`: a compound operator reads and converts, a key the check cannot read could spell
        // `__proto__`, and a target that may hold a setter (an import, a class instance, anything not built here
        // from a literal) could run one.
        const { expression } = node;
        if (expression.type !== 'AssignmentExpression' || expression.operator !== '=') return effect(expression);
        const { left } = expression;
        if (left.type !== 'MemberExpression' || left.optional || left.object.type !== 'Identifier') return effect(left);
        if (!writable.has(valueOf(left.object))) effect(left.object);
        const { property } = left;
        const key = !left.computed
          ? property.type === 'Identifier' && property.name
          : property.type === 'Literal' && ['string', 'number'].includes(typeof property.value) && String(property.value);
        if (!key || key === '__proto__') effect(property);
        valueOf(expression.right);
        return;
      }
      default:
        return effect(node);
    }
  };

  for (const node of program.body) {
    try {
      statement(node);
    } catch (error) {
      if (!(error instanceof Effect)) throw error;
      const { start, end } = error.node;
      const line = code.slice(0, start).split('\n').length;
      drift(file, `a top-level value that may have effects (line ${line}: ${code.slice(start, end).slice(0, 80)})`);
    }
  }
}

/**
 * Each identifier a program reads, with its offset: every Identifier except non-computed member, key and meta-property
 * names. Bindings count too, so a local that shadows a wrapper's name fails closed.
 */
function identifierReads(program: ReturnType<typeof parseProgram>) {
  const reads: { name: string; at: number }[] = [];
  const names = new Set<object>();
  const key = (node: { computed: boolean; key: object }) => void (node.computed || names.add(node.key));
  new Visitor({
    MemberExpression: (node) => void (node.computed || names.add(node.property)),
    Property: (node) => void (node.computed || node.shorthand || names.add(node.key)),
    MethodDefinition: key,
    PropertyDefinition: key,
    AccessorProperty: key,
    MetaProperty: (node) => void names.add(node.meta).add(node.property),
    Identifier: (node) => void (names.has(node) || reads.push({ name: node.name, at: node.start })),
  }).visit(program);
  return reads;
}

/**
 * substrate.js in three parts: its imports, its helpers (every top-level statement that is not exported) and its
 * exported wrappers by name. Each wrapper's module imports only the helpers, so a wrapper or helper that reads another
 * wrapper is drift. Every initialiser must also be free of effects (assertPureTopLevel): a wrapper no route imports is left out
 * of the client, so an effect in it would run on the server and silently not in the browser.
 */
export function splitSubstrate(file: string, code = readFileSync(file, 'utf8')) {
  const imports: string[] = [];
  const helpers: string[] = [];
  const names: string[] = [];
  const wrappers = new Map<string, string>();
  const statements: { node: { start: number; end: number }; wrapper?: string }[] = [];
  const program = parseProgram(file, code);
  for (const node of program.body) {
    const text = code.slice(node.start, node.end);
    if (node.type === 'ImportDeclaration') imports.push(text);
    else if (node.type === 'ExportNamedDeclaration') {
      const declarator = node.declaration?.type === 'VariableDeclaration' ? node.declaration.declarations : [];
      const id = declarator.length === 1 ? declarator[0]!.id : undefined;
      if (id?.type !== 'Identifier') substrateDrift(file, 'an export other than `export const AriaX = ...`');
      wrappers.set(id.name, text);
      statements.push({ node, wrapper: id.name });
    } else if (node.type.startsWith('Export')) substrateDrift(file, `an ${node.type}`);
    else {
      if (node.type === 'FunctionDeclaration' && node.id) names.push(node.id.name);
      else if (node.type === 'VariableDeclaration')
        for (const { id } of node.declarations) {
          if (id.type !== 'Identifier') substrateDrift(file, 'a destructured helper');
          names.push(id.name);
        }
      else substrateDrift(file, `a top-level ${node.type}`);
      helpers.push(text);
      statements.push({ node });
    }
  }
  if (wrappers.size === 0) substrateDrift(file, 'no `export const AriaX` wrappers');
  for (const { name, at } of identifierReads(program)) {
    if (!wrappers.has(name)) continue;
    const statement = statements.find(({ node }) => node.start <= at && at < node.end);
    if (statement && statement.wrapper !== name)
      substrateDrift(file, `${statement.wrapper ?? 'a helper'} reading the exported wrapper ${name}`);
  }
  assertPureTopLevel(file, code, substrateDrift);
  return { imports: imports.join('\n'), helpers: helpers.join('\n'), names: names.join(', '), wrappers };
}

/**
 * Whether the module specifier `source`, in the Mux file `id`, names the substrate.js beside it. A relative or absolute
 * path is resolved before comparing, so `'././substrate.js'` names it too. A spelling that may name it but cannot be
 * proven to (no extension, a query, a package path) fails the build, since leaving it would load substrate.js whole.
 */
function namesSubstrate(id: string, source: string) {
  const file = join(dirname(id), 'substrate.js');
  if (source.startsWith(file + substrateQuery)) return false;
  const path = source.replace(/[?#].*$/s, '');
  const relative = /^\.\.?[\\/]/.test(path) || isAbsolute(path);
  const resolved = relative ? resolve(dirname(id), path) : path;
  if (relative && resolved === file && path === source) return true;
  const named = relative
    ? resolved.replace(/\.m?js$/, '') === file.replace(/\.js$/, '')
    : /[\\/]substrate(\.m?js)?$|^substrate\.m?js$/.test(path);
  if (named) substrateDrift(id, `a reference to substrate.js as '${source}', which the split cannot rewrite`);
  return false;
}

/**
 * Points each `import { AriaX } from './substrate.js'` in a Mux file (`id`) at the module that holds only AriaX. Fails
 * closed on every other way to reach substrate.js (a default, namespace or side-effect-only import, a re-export, a
 * dynamic import, any other string naming it), since each would load the whole module and undo the split. A dynamic
 * import of a computed name cannot be seen here.
 */
export function rewriteSubstrateImports(id: string, code: string) {
  const file = join(dirname(id), 'substrate.js');
  const program = parseProgram(id, code);
  const rewritten = new Set<number>();
  let out = '';
  let last = 0;
  for (const node of program.body) {
    if (node.type !== 'ImportDeclaration' || !namesSubstrate(id, node.source.value)) continue;
    if (node.specifiers.length === 0) substrateDrift(id, 'a side-effect-only import of substrate.js');
    if (node.phase || node.attributes.length > 0) substrateDrift(id, 'an import of substrate.js with a phase or attributes');
    const imports = node.specifiers.map((specifier) =>
      specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier'
        ? `import { ${specifier.imported.name} as ${specifier.local.name} } from ${substratePartId(file, specifier.imported.name)};`
        : substrateDrift(
            id,
            `${specifier.type === 'ImportNamespaceSpecifier' ? 'a namespace' : 'a default or string-named'} import of substrate.js`,
          ),
    );
    rewritten.add(node.source.start);
    out += code.slice(last, node.start) + imports.join(' ');
    last = node.end;
  }
  // Any other string naming substrate.js: a re-export, `import()`, or a path handed to code.
  const unrewritten = (what: string) => (node: { start: number; value: unknown }) => {
    if (typeof node.value === 'string' && !rewritten.has(node.start) && namesSubstrate(id, node.value)) substrateDrift(id, what);
  };
  new Visitor({
    ExportNamedDeclaration: (node) => node.source && unrewritten('a re-export of substrate.js')(node.source),
    ExportAllDeclaration: (node) => unrewritten('a re-export of substrate.js')(node.source),
    ImportExpression: (node) => node.source.type === 'Literal' && unrewritten('a dynamic import of substrate.js')(node.source),
    Literal: unrewritten('a reference to substrate.js'),
    TemplateElement: (node) => unrewritten('a reference to substrate.js')({ start: node.start, value: node.value.cooked }),
  }).visit(program);
  // The rewrite moves code across lines, so client source maps need mappings for it and for the virtual modules first.
  return last === 0 ? null : { code: out + code.slice(last), map: null };
}

/**
 * Splits Mux UI's substrate.js into one module per React Aria wrapper, in the client build only.
 *
 * substrate.js defines every `AriaX` wrapper (`withMuxState(RAC.X, ...)`) in one module, and the bundler assigns
 * chunks by module. Every route reaches substrate.js (Button imports it), so the wrapper of any family some route
 * uses, with the React Aria code behind it (Menu, Modal, Toast, Tooltip, selection, drag and drop), landed in the
 * vendor-mux chunk every route loads. A scratch build that imports only Button does not show it, because there the
 * other wrappers are shaken out. Here each `import { AriaX } from './substrate.js'` in Mux's files points at a module
 * that holds only `AriaX`, which imports substrate's helpers from one shared module, so each family's React Aria code
 * follows the routes that use it. The vendored tarball is untouched, and the rewrite throws when substrate.js changes
 * shape, so a Mux update cannot quietly undo it.
 */
export function splitMuxSubstrate(): Plugin {
  const parts = new Map<string, ReturnType<typeof splitSubstrate>>();
  return {
    name: 'peblish:split-mux-substrate',
    apply: 'build',
    applyToEnvironment: (environment) => environment.name === 'client',
    resolveId: { filter: { id: /\?mux-substrate=/ }, handler: (source) => source },
    load: {
      filter: { id: /\?mux-substrate=/ },
      handler(id) {
        const at = id.indexOf(substrateQuery);
        const [file, part] = [id.slice(0, at), id.slice(at + substrateQuery.length)];
        const substrate = parts.get(file) ?? splitSubstrate(file);
        parts.set(file, substrate);
        if (part === substrateHelpers)
          return { code: `${substrate.imports}\n${substrate.helpers}\nexport { ${substrate.names} };\n`, moduleSideEffects: false };
        const wrapper = substrate.wrappers.get(part) ?? substrateDrift(file, `no wrapper named ${part}`);
        return {
          code: `${substrate.imports}\nimport { ${substrate.names} } from ${substratePartId(file, substrateHelpers)};\n${wrapper}\n`,
          moduleSideEffects: false,
        };
      },
    },
    transform: {
      filter: { id: /[\\/]@muxui[\\/]react[\\/]generated[\\/][^\\/?]+\.m?js$/, code: 'substrate' },
      handler: (code, id) => rewriteSubstrateImports(id, code),
    },
  };
}

const declarationQuery = '?mux-declaration=';

function declarationDrift(file: string, what: string): never {
  throw new Error(
    `peblish:split-mux-declarations: ${what} in ${file}. This Mux UI module changed shape; update splitMuxDeclarations in vite.config.ts.`,
  );
}

/**
 * Mux UI modules that hold several families, split one module per top-level declaration in the client build.
 *
 * overlays.js holds Dialog, DropZone, FileTrigger, Popover, PreviewTrigger, Toast and Tooltip. Tree shaking is
 * global, so every export some route uses stays in that one module, and every page loads it because the Sidebar
 * needs its Tooltip: the drop zone's drag and drop, the dialog and the preview trigger came with the Sidebar to every
 * page. Split by declaration, each route loads only the declarations it reaches (5.4 kB gzip less on the home page,
 * 5.7 kB on sign-in, measured 2026-11-11).
 */
const splitByDeclaration = /[\\/]@muxui[\\/]react[\\/]generated[\\/]overlays\.js$/;

/**
 * A module in parts: its imports, and each top-level declaration by its first name with the names it declares and the
 * other declarations it reads. A statement that sets a property on a declaration (`Tooltip.displayName = ...`) goes
 * with it. Fails closed on anything else but imports, function and variable declarations and their named exports, so
 * a Mux update that changes the shape breaks the build instead of the page. Every initialiser and property-set value
 * must also be free of effects (assertPureTopLevel): a part runs only when an import reaches it, so an effect would run on the
 * server, which loads the whole module, and silently not in the client.
 */
export function splitDeclarations(file: string, code = readFileSync(file, 'utf8')) {
  const program = parseProgram(file, code);
  assertPureTopLevel(file, code, declarationDrift);
  const imports: string[] = [];
  const declarations = new Map<string, { names: string[]; exported: boolean; text: string; ranges: { start: number; end: number }[] }>();
  const owner = new Map<string, string>();
  for (const node of program.body) {
    const text = code.slice(node.start, node.end);
    if (node.type === 'ImportDeclaration') {
      if (node.specifiers.length === 0) declarationDrift(file, 'a side-effect-only import');
      imports.push(text);
      continue;
    }
    if (node.type === 'ExpressionStatement') {
      const { expression } = node;
      const target =
        expression.type === 'AssignmentExpression' &&
        expression.left.type === 'MemberExpression' &&
        expression.left.object.type === 'Identifier'
          ? declarations.get(owner.get(expression.left.object.name) ?? '')
          : undefined;
      if (!target) declarationDrift(file, 'a top-level expression other than a property set on a declaration');
      target.text += `\n${text}`;
      target.ranges.push({ start: node.start, end: node.end });
      continue;
    }
    const exported = node.type === 'ExportNamedDeclaration';
    const declaration = exported ? node.declaration : node;
    if (exported && (!declaration || node.source)) declarationDrift(file, 'an export list or re-export');
    if (!declaration) declarationDrift(file, `a top-level ${node.type}`);
    let names: string[];
    if (declaration.type === 'FunctionDeclaration' && declaration.id) names = [declaration.id.name];
    else if (declaration.type === 'VariableDeclaration')
      names = declaration.declarations.map(({ id }) =>
        id.type === 'Identifier' ? id.name : declarationDrift(file, 'a destructured declaration'),
      );
    else declarationDrift(file, `a top-level ${declaration.type}`);
    for (const name of names) owner.set(name, names[0]!);
    declarations.set(names[0]!, { names, exported, text, ranges: [{ start: node.start, end: node.end }] });
  }
  const reads = new Map<string, Set<string>>([...declarations.keys()].map((key) => [key, new Set()]));
  for (const { name, at } of identifierReads(program)) {
    const target = owner.get(name);
    if (!target) continue;
    const [reader] = [...declarations].find(([, { ranges }]) => ranges.some(({ start, end }) => start <= at && at < end)) ?? [];
    if (reader && reader !== target) reads.get(reader)!.add(target);
  }
  return { imports: imports.join('\n'), declarations, reads };
}

/**
 * Splits each module matched by `splitByDeclaration` into one virtual module per top-level declaration, client build
 * only. The module itself becomes re-exports of its exported declarations; each part carries the module's imports
 * (unused ones are shaken out) and imports the declarations it reads from their parts. All are side-effect free,
 * which holds because splitDeclarations fails the build on any top-level value that may have effects (any call or
 * `new` but those marked pure and a short list of known factories, tagged templates, assignments, getters; see assertPureTopLevel)
 * rather than let such work run on the server and vanish from the client.
 */
export function splitMuxDeclarations(): Plugin {
  const parts = new Map<string, ReturnType<typeof splitDeclarations>>();
  const partsOf = (file: string) => parts.get(file) ?? parts.set(file, splitDeclarations(file)).get(file)!;
  const partId = (file: string, key: string) => JSON.stringify(file + declarationQuery + key);
  return {
    name: 'peblish:split-mux-declarations',
    apply: 'build',
    applyToEnvironment: (environment) => environment.name === 'client',
    resolveId: { filter: { id: /\?mux-declaration=/ }, handler: (source) => source },
    load: {
      filter: { id: /\?mux-declaration=/ },
      handler(id) {
        const at = id.indexOf(declarationQuery);
        const [file, key] = [id.slice(0, at), id.slice(at + declarationQuery.length)];
        const { imports, declarations, reads } = partsOf(file);
        const part = declarations.get(key) ?? declarationDrift(file, `no declaration named ${key}`);
        const own = [...reads.get(key)!].map((dependency) => {
          const names = declarations.get(dependency)!.names.join(', ');
          return `import { ${names} } from ${partId(file, dependency)};`;
        });
        const code = [imports, ...own, part.text, part.exported ? '' : `export { ${part.names.join(', ')} };`].join('\n');
        // The parts keep the module's substrate imports, which the substrate split points at single wrappers.
        return { code: rewriteSubstrateImports(file, code)?.code ?? code, moduleSideEffects: false };
      },
    },
    transform: {
      filter: { id: splitByDeclaration },
      handler(_code, id) {
        const exports = [...partsOf(id).declarations].filter(([, { exported }]) => exported);
        const code = exports.map(([key, { names }]) => `export { ${names.join(', ')} } from ${partId(id, key)};`).join('\n');
        return { code, map: null, moduleSideEffects: false };
      },
    },
  };
}

/** Which chunk each package landed in, written next to the build for the budget check (e2e/payload). */
function payloadChunks(): Plugin {
  const packageOf = (id: string) => /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)[\\/](?!.*[\\/]node_modules[\\/])/.exec(id)?.[1];
  return {
    name: 'peblish:payload-chunks',
    apply: 'build',
    writeBundle(options, bundle) {
      if (this.environment.name !== 'client' || !options.dir) return;
      const chunks = Object.values(bundle).flatMap((output) =>
        output.type === 'chunk'
          ? [
              {
                file: output.fileName,
                entry: output.isEntry,
                packages: [...new Set(output.moduleIds.flatMap((id) => packageOf(id) ?? []))].sort(),
                app: output.moduleIds.some((id) => !/[\\/]node_modules[\\/]/.test(id)),
              },
            ]
          : [],
      );
      const file = join(dirname(options.dir), 'payload-chunks.json');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        `${JSON.stringify({ vendorGroups: Object.fromEntries(Object.entries(vendorGroups).map(([name, test]) => [name, test.source])), chunks }, null, 2)}\n`,
      );
    },
  };
}

// Plugin order follows the TanStack Start hosting guide: Start, then Nitro, then React.
// Dev and preview use the lane's port (G0 18300; scripts/lane.sh prints each lane's).
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PORT ?? 18300),
    strictPort: true,
    // File events from a macOS bind mount do not reach a container; poll there instead.
    watch: process.env.VITE_USE_POLLING === '1' ? { usePolling: true, interval: 300 } : undefined,
  },
  resolve: { dedupe: ['react', 'react-dom'] },
  environments: {
    client: {
      build: {
        rolldownOptions: {
          output: { codeSplitting: { groups: Object.entries(vendorGroups).map(([name, test]) => ({ name, test, entriesAware: true })) } },
        },
      },
    },
  },
  plugins: [
    { ...optimizeLocales.vite({ locales }), enforce: 'pre' },
    tanstackStart(),
    // Without '!unwasm', shiki/wasm (pulled in by @muxui/react through @peblish/ui) resolves to
    // onig.wasm, which the SSR environment's bundler cannot link. The JS loader works the same.
    nitro({ preset: 'node-server', exportConditions: ['!unwasm'], plugins: ['./src/server/shutdown.ts'] }),
    viteReact(),
    splitMuxSubstrate(),
    splitMuxDeclarations(),
    payloadChunks(),
  ],
});
