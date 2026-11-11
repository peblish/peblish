// The Mux UI guard: reports UI code that is not Mux UI.
//
//   node scripts/mux-guard.ts             report; fails only if a file got worse than the baseline
//   node scripts/mux-guard.ts --enforce   fails on any violation
//   node scripts/mux-guard.ts --baseline  writes the current counts to mux-guard.baseline.json
//
// Every element on every page is a Mux UI component (through the wrappers in packages/ui), or is
// layout markup composed only of Mux components and styled only with Mux tokens. In every mode an
// entry of mux-guard.exceptions.json that does not match exactly its `count` violations fails.
//
// Scope: every script and stylesheet the build can import (.ts .tsx .mts .cts .js .jsx .mjs .cjs .css)
// anywhere under packages/* and tools/*, except node_modules, build output, generated *.gen.ts files,
// tests, fixtures and pure wrapper modules (a file whose only statements re-export @muxui/react).
// packages/ui/src/styles.css, which imports Mux's own stylesheet, may hold only @import and @layer.
import { globSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { gunzipSync } from 'node:zlib';
import ts from 'typescript';

export const scriptRules = [
  'raw-element',
  'text-element',
  'bare-text',
  'widget-role',
  'widget-handler',
  'inline-style',
  'raw-html',
  'mux-import',
] as const;
export const cssRules = [
  'css-colour',
  'css-radius',
  'css-shadow',
  'css-font-family',
  'css-font-size',
  'css-font-weight',
  'css-line-height',
  'css-letter-spacing',
  'css-spacing',
  'css-motion',
  'css-infinite',
  'css-important',
  'css-unknown-token',
  'css-token-value',
  'css-blur',
  'css-element-selector',
  'css-import',
  'css-mux-stylesheet',
] as const;
export const rules = [...scriptRules, ...cssRules] as const;
export type Rule = (typeof rules)[number];

const root = join(import.meta.dirname, '..');
const baselinePath = join(import.meta.dirname, 'mux-guard.baseline.json');
const exceptionsPath = join(import.meta.dirname, 'mux-guard.exceptions.json');
/** The vendored Mux UI tarball, read from packages/ui's `file:` dependency so a swap needs no edit here. */
export const muxTarball = vendoredTarball(readFileSync(join(root, 'packages/ui/package.json'), 'utf8'));
const tokensFile = 'packages/ui/src/tokens/tokens.css';
// The file that imports Mux UI's own stylesheet and nothing else.
const muxStylesheet = 'packages/ui/src/styles.css';
// The only files that may render a raw <time> and a raw <svg>.
const timeModule = 'packages/ui/src/components/time.tsx';
const iconsModule = 'packages/ui/src/components/icons.tsx';

/**
 * `anchor` names what encloses a violation (components and functions, or CSS preludes), for exceptions; a CSS
 * declaration's violation also carries its `value`, and a type selector's its `selector` list.
 */
export type Violation = { file: string; line: number; rule: Rule; detail: string; anchor?: string[]; value?: string; selector?: string };
export type Counts = Record<string, Partial<Record<Rule, number>>>;

// Elements Mux has a component for, and what to use instead.
const replacements: Record<string, string> = {
  button: 'Button',
  input: 'Input or a field',
  select: 'Select',
  textarea: 'TextArea',
  dialog: 'Dialog',
  table: 'Table',
  thead: 'Table',
  tbody: 'Table',
  tfoot: 'Table',
  tr: 'Table',
  td: 'Table',
  th: 'Table',
  caption: 'Table',
  a: 'Link',
  img: 'Image or Avatar',
  hr: 'Separator',
  time: 'Time',
  details: 'Disclosure',
  summary: 'Disclosure',
  fieldset: 'a Mux group or field',
  legend: 'a Mux group or field',
  progress: 'ProgressBar',
  meter: 'Meter',
  svg: 'an icon from icons.tsx',
  style: 'a stylesheet file',
};
const textTags = new Set('h1 h2 h3 h4 h5 h6 p strong b em i small code pre blockquote label br'.split(' '));
// Layout and landmark elements: allowed, but not with text or widget behaviour of their own.
const layoutTags = new Set('div span section article main nav header footer aside ul ol li dl dt dd form'.split(' '));
const widgetRoles = new Set(
  (
    'button link tab tablist tabpanel menu menuitem dialog alertdialog alert status switch checkbox radio radiogroup ' +
    'listbox option combobox tooltip progressbar meter separator'
  ).split(' '),
);
const widgetHandlers = new Set(['onClick', 'onKeyDown', 'tabIndex']);
const handlerTags = new Set(['div', 'span', 'li', 'section', 'article']);
const insertions = new Set([
  'append',
  'appendChild',
  'prepend',
  'before',
  'after',
  'insertBefore',
  'replaceWith',
  'replaceChildren',
  'insertAdjacentElement',
]);

const isMux = (specifier: string) => specifier === '@muxui/react' || specifier.startsWith('@muxui/react/');
const lineOf = (source: ts.SourceFile, node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

/** Every import, export-from, dynamic import or import type with a written specifier, and its line. */
function importSpecifiers(source: ts.SourceFile): { line: number; specifier: string }[] {
  const found: { line: number; specifier: string }[] = [];
  const add = (node: ts.Node, specifier: ts.Node | undefined) => {
    if (specifier && ts.isStringLiteralLike(specifier)) found.push({ line: lineOf(source, node), specifier: specifier.text });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node, node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      add(node, node.moduleReference.expression);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node, node.arguments[0]);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node, node.argument.literal);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Lines of every import, export-from, dynamic import or import type of @muxui/react. */
const muxImportLines = (source: ts.SourceFile) =>
  importSpecifiers(source)
    .filter(({ specifier }) => isMux(specifier))
    .map(({ line }) => line);

/** A pure wrapper: every statement is an export-from of @muxui/react (values or types). */
export function isWrapper(source: ts.SourceFile): boolean {
  return (
    source.statements.length > 0 &&
    source.statements.every(
      (statement) =>
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier !== undefined &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        isMux(statement.moduleSpecifier.text),
    )
  );
}

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) ? unwrap(node.expression) : node;

/**
 * An element's props as the rules read them, in order, so a later prop wins: each name's value, or
 * undefined for a bare attribute (`disabled`) or a method. JSX attributes, spreads of object literals
 * and createElement's props object all land here.
 */
type Props = Map<string, ts.Expression | undefined>;

/** The string a literal prop holds: `a="x"`, `a={'x'}` or `a: 'x'`. */
function propText(value: ts.Expression | undefined): string | undefined {
  const expression = value && unwrap(value);
  return expression && ts.isStringLiteralLike(expression) ? expression.text : undefined;
}

/** A property's name when it is written out (`a`, `'a'`, `['a']`). */
function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(unwrap(name.expression)))
    return (unwrap(name.expression) as ts.StringLiteral).text;
  return undefined;
}

/**
 * Adds an object's properties to `props`, as a spread does. An object literal is read property by property;
 * anything else (rest props, a variable) is opaque, as is a computed name, and may set any prop, so it takes
 * away a `type` written before it (the hidden-input allowance needs to see the final type).
 */
function spreadProps(props: Props, expression: ts.Expression) {
  const object = unwrap(expression);
  if (!ts.isObjectLiteralExpression(object)) return void props.delete('type');
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      spreadProps(props, property.expression);
      continue;
    }
    const name = property.name && propertyName(property.name);
    if (name === undefined) props.delete('type');
    else if (ts.isPropertyAssignment(property)) props.set(name, property.initializer);
    else if (ts.isShorthandPropertyAssignment(property)) props.set(name, property.name);
    else props.set(name, undefined);
  }
}

/** A JSX element's props, spreads included. */
function jsxProps(attributes: ts.JsxAttributes): Props {
  const props: Props = new Map();
  for (const attribute of attributes.properties) {
    if (ts.isJsxSpreadAttribute(attribute)) spreadProps(props, attribute.expression);
    else {
      const init = attribute.initializer;
      props.set(attribute.name.getText(), init && ts.isJsxExpression(init) ? init.expression : init);
    }
  }
  return props;
}

// React's element factories, and the modules they come from.
const reactModules = new Set(['react', 'react/jsx-runtime', 'react/jsx-dev-runtime']);
const factoryNames = new Set(['createElement', 'cloneElement', 'jsx', 'jsxs', 'jsxDEV']);

/**
 * The local names that are React element factories (`createElement`, `jsx` and the rest, however imported or
 * renamed) and the names that hold React itself (`React`, `import * as R`), so `R.createElement` is one too.
 */
function reactFactories(source: ts.SourceFile) {
  const factories = new Set(['createElement']);
  const namespaces = new Set(['React']);
  const isFactory = (node: ts.Expression): boolean => {
    const expression = unwrap(node);
    if (ts.isIdentifier(expression)) return factories.has(expression.text);
    return (
      ts.isPropertyAccessExpression(expression) &&
      factoryNames.has(expression.name.text) &&
      ts.isIdentifier(expression.expression) &&
      namespaces.has(expression.expression.text)
    );
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && reactModules.has(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (clause?.name) namespaces.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      else if (bindings)
        for (const element of bindings.elements)
          if (factoryNames.has((element.propertyName ?? element.name).text)) factories.add(element.name.text);
    } else if (ts.isVariableDeclaration(node) && node.initializer) {
      // const h = createElement; const { createElement: h } = React; const R = React.
      const init = unwrap(node.initializer);
      if (ts.isIdentifier(node.name)) {
        if (isFactory(init)) factories.add(node.name.text);
        else if (ts.isIdentifier(init) && namespaces.has(init.text)) namespaces.add(node.name.text);
      } else if (ts.isObjectBindingPattern(node.name) && ts.isIdentifier(init) && namespaces.has(init.text)) {
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name;
          if (ts.isIdentifier(key) && factoryNames.has(key.text) && ts.isIdentifier(element.name)) factories.add(element.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return isFactory;
}

/** An expression that is plainly visible text: a string, a template, a t(...) call, or a choice between them. */
function plainlyText(node: ts.Expression): boolean {
  const expression = unwrap(node);
  if (ts.isStringLiteralLike(expression)) return expression.text.trim() !== '';
  if (ts.isTemplateExpression(expression)) return true;
  if (ts.isCallExpression(expression)) {
    const callee = expression.expression;
    return (ts.isIdentifier(callee) && callee.text === 't') || (ts.isPropertyAccessExpression(callee) && callee.name.text === 't');
  }
  if (ts.isConditionalExpression(expression)) return plainlyText(expression.whenTrue) || plainlyText(expression.whenFalse);
  if (ts.isBinaryExpression(expression)) {
    const op = expression.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return plainlyText(expression.right);
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken)
      return plainlyText(expression.left) || plainlyText(expression.right);
    if (op === ts.SyntaxKind.PlusToken) return plainlyText(expression.left) || plainlyText(expression.right);
  }
  return false;
}

const kebab = (name: string) => name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
const bannedStyle =
  /^(color|background|border|outline|opacity|box-shadow|text-shadow|font|line-height|letter-spacing|transition|animation|fill|stroke|caret-color|accent-color|text-decoration-color|column-rule)|-radius$|-color$/;
const spacingStyle = /^(padding|margin|gap|row-gap|column-gap|inset)/;
const tokenRef = /^var\(\s*--(muxui|pb)-[\w-]+\s*\)$/;

/** Inline style problems in one `style={...}` value (an object literal, or a choice between them). */
function styleProblems(node: ts.Expression): string[] {
  const expression = unwrap(node);
  if (ts.isConditionalExpression(expression)) return [...styleProblems(expression.whenTrue), ...styleProblems(expression.whenFalse)];
  if (expression.kind === ts.SyntaxKind.UndefinedKeyword || expression.kind === ts.SyntaxKind.NullKeyword) return [];
  if (ts.isIdentifier(expression) && expression.text === 'undefined') return [];
  if (!ts.isObjectLiteralExpression(expression)) return ['not an object literal'];
  return expression.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)))
      return [`unreadable property ${property.getText().slice(0, 30)}`];
    const name = property.name.text.startsWith('--') ? property.name.text : kebab(property.name.text);
    const value = unwrap(property.initializer);
    const literal = ts.isStringLiteralLike(value) ? value.text.trim() : ts.isNumericLiteral(value) ? value.text : undefined;
    // The written text of the value, a template's literal parts included, for the token names it reads.
    const written = ts.isTemplateExpression(value)
      ? [value.head.text, ...value.templateSpans.map((span) => span.literal.text)]
      : [literal ?? ''];
    // A --muxui-* name Mux UI does not define is no token, set or read (as in stylesheets).
    const made = [name, ...written.flatMap((text) => [...text.matchAll(/var\(\s*(--muxui-[\w-]+)/g)].map((match) => match[1]!))].find(
      (token) => token.startsWith('--muxui-') && !muxTokens().has(token),
    );
    if (made) return [`${name}: ${made} is not a Mux UI token`];
    // Setting a Mux token inline is theming, so only to another Mux token, written out: `'var(--muxui-...)'`.
    if (name.startsWith('--muxui-'))
      return ts.isStringLiteralLike(value) && /^var\(\s*--muxui-[\w-]+\s*\)$/.test(value.text.trim())
        ? []
        : [`${name}: ${literal ?? property.initializer.getText()} (only a var() of a Mux token may set a Mux token)`];
    if (name.startsWith('--')) {
      // A custom property may carry data (a depth, a count); a string it sets must be tokens.
      return literal !== undefined && ts.isStringLiteralLike(value) && literals(literal, anyAlias).length ? [`${name}: ${literal}`] : [];
    }
    // React writes cssText straight onto the element's style, a whole declaration list in one string.
    if (name === 'css-text') return [`cssText: ${literal ?? property.initializer.getText()}`];
    if (bannedStyle.test(name)) return [`${name}: ${literal ?? property.initializer.getText()}`];
    if (spacingStyle.test(name)) {
      const ok = literal !== undefined && (Number(literal) === 0 || literal === 'auto' || tokenRef.test(literal));
      return ok ? [] : [`${name}: ${literal ?? property.initializer.getText()}`];
    }
    return [];
  });
}

const scriptKinds: Record<string, ts.ScriptKind> = {
  tsx: ts.ScriptKind.TSX,
  jsx: ts.ScriptKind.JSX,
  js: ts.ScriptKind.JS,
  mjs: ts.ScriptKind.JS,
  cjs: ts.ScriptKind.JS,
};
// Folders the build writes or a package manager fills, which the walk skips.
const unwalked = /(^|\/)(node_modules|dist|build|coverage|\.output|\.nitro|\.vite|\.turbo|\.tanstack)\//;

/** Whether the guard reads this repository path: a source file under packages/* or tools/*, outside build output. */
export function walked(file: string): boolean {
  return /^(packages|tools)\/[^/]+\//.test(file) && !unwalked.test(file) && !file.endsWith('.gen.ts') && !isTestOrFixture(file);
}

/**
 * A stylesheet import the guard cannot follow: one that lands outside the walk (a package's own CSS, a file
 * outside packages/* and tools/*). Relative paths and @peblish/ui's are resolved; Mux's own stylesheet may be
 * imported by packages/ui/src/styles.css alone (and anywhere else outside packages/ui/src is mux-import).
 */
function unreadImport(file: string, specifier: string): boolean {
  const path = specifier.replace(/[?#].*$/, '');
  if (isMux(path)) return file !== muxStylesheet && file.startsWith('packages/ui/src/');
  if (path.startsWith('.')) return !walked(posix.normalize(posix.join(posix.dirname(file), path)));
  if (path.startsWith('@peblish/ui/')) return !walked(`packages/ui/src/${path.slice('@peblish/ui/'.length)}`);
  return true;
}

/** `x.style` (or `x['style']`): an element's own style declarations. */
const isStyleObject = (node: ts.Expression) =>
  (ts.isPropertyAccessExpression(node) && node.name.text === 'style') ||
  (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'style');

/** Scans a script for every script rule. */
export function scanScript(file: string, text: string): Violation[] {
  const kind = scriptKinds[file.slice(file.lastIndexOf('.') + 1)] ?? ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const out: Violation[] = [];
  if (!file.startsWith('packages/ui/src/')) {
    for (const line of muxImportLines(source)) out.push({ file, line, rule: 'mux-import', detail: '@muxui/react' });
  }
  for (const { line, specifier } of importSpecifiers(source))
    if (/\.css([?#]|$)/.test(specifier) && unreadImport(file, specifier))
      out.push({ file, line, rule: 'css-import', detail: `${specifier} is a stylesheet the guard does not read` });
  if (isWrapper(source)) return out;

  const anchor: string[] = [];
  const add = (node: ts.Node, rule: Rule, detail: string) =>
    out.push({ file, line: lineOf(source, node), rule, detail, anchor: [...anchor] });
  const tagRule = (tag: string): Rule | undefined => (textTags.has(tag) ? 'text-element' : tag in replacements ? 'raw-element' : undefined);
  const hint = (tag: string) => (textTags.has(tag) ? 'Text' : replacements[tag]);
  // Elements made with document.createElement count only once inserted into the page.
  const created = new Map<string, Violation>();
  const inserted = new Set<string>();

  const isFactory = reactFactories(source);
  // Stylesheets imported as text (`import css from './x.css?inline'`), which the guard reads as files: the
  // only content a <style> element may have.
  const inlineSheets = new Set(
    source.statements.flatMap((statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.endsWith('.css?inline') &&
      !unreadImport(file, statement.moduleSpecifier.text) &&
      statement.importClause?.name
        ? [statement.importClause.name.text]
        : [],
    ),
  );
  const inlinedSheet = (props: Props, children: readonly ts.Node[]) => {
    const content = children.filter((child) => !(ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces));
    const only = content.length === 1 ? content[0]! : undefined;
    const expression = only && ts.isJsxExpression(only) ? only.expression : only && ts.isExpression(only) ? only : undefined;
    return (
      !props.has('dangerouslySetInnerHTML') && expression !== undefined && ts.isIdentifier(expression) && inlineSheets.has(expression.text)
    );
  };

  /**
   * The element rules over one element, written as JSX or made with a React factory. `tag` is undefined for a
   * component, which gets only the style rule; `made` names the factory call for a raw element's report.
   */
  const element = (node: ts.Node, tag: string | undefined, props: Props, children: readonly ts.Node[], made?: string) => {
    // An inline style bypasses the stylesheet rules on components as much as on raw elements.
    const name = tag ?? (ts.isJsxOpeningLikeElement(node) ? node.tagName.getText() : 'component');
    if (props.has('style')) {
      const style = props.get('style');
      if (style) for (const problem of styleProblems(style)) add(node, 'inline-style', `<${name}> style ${problem}`);
    }
    if (tag === undefined) return;

    const rule = tagRule(tag);
    const hidden = tag === 'input' && propText(props.get('type')) === 'hidden';
    const home =
      (tag === 'time' && file === timeModule) ||
      (tag === 'svg' && file === iconsModule) ||
      (tag === 'style' && inlinedSheet(props, children));
    if (rule && !hidden && !home) add(node, rule, `${made ?? `<${tag}>`} (${hint(tag)})`);

    const roleText = propText(props.get('role'));
    if (roleText && widgetRoles.has(roleText)) add(node, 'widget-role', `<${tag} role="${roleText}">`);
    if (handlerTags.has(tag)) {
      // tabIndex={-1} only makes an element a focus target (the skip link's), not a widget.
      const handlers = [...props].filter(
        ([prop, value]) => widgetHandlers.has(prop) && !(prop === 'tabIndex' && value && unwrap(value).getText() === '-1'),
      );
      if (handlers.length) add(node, 'widget-handler', `<${tag} ${handlers.map(([prop]) => prop).join(' ')}>`);
    }
    if (layoutTags.has(tag)) {
      const textChild = children.find((child) =>
        ts.isJsxText(child)
          ? !child.containsOnlyTriviaWhiteSpaces && child.text.trim() !== ''
          : ts.isJsxExpression(child)
            ? child.expression !== undefined && plainlyText(child.expression)
            : ts.isExpression(child) && plainlyText(child),
      );
      if (textChild)
        add(node, 'bare-text', `<${tag}> text ${JSON.stringify(textChild.getText().trim().replace(/\s+/g, ' ').slice(0, 40))}`);
    }
    if (props.has('dangerouslySetInnerHTML') && tag !== 'script' && tag !== 'style')
      add(node, 'raw-html', `<${tag} dangerouslySetInnerHTML>`);
  };
  const jsxElement = (node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, children: readonly ts.JsxChild[]) => {
    const tag = node.tagName.getText();
    element(node, ts.isIdentifier(node.tagName) && /^[a-z]/.test(tag) ? tag : undefined, jsxProps(node.attributes), children);
  };
  /** createElement(type, props, ...children), jsx(type, props) and cloneElement(element, props), however named. */
  const factoryElement = (node: ts.CallExpression) => {
    const [type, propsArgument, ...rest] = node.arguments;
    const props: Props = new Map();
    if (propsArgument) spreadProps(props, propsArgument);
    const callee = node.expression.getText();
    const cloned = /(^|\.)cloneElement$/.test(callee);
    const tag = !cloned && type && ts.isStringLiteralLike(type) ? type.text : undefined;
    const children = props.get('children');
    element(node, tag, props, children ? [children, ...rest] : rest, tag && `${callee}('${tag}')`);
  };

  const visit = (node: ts.Node): void => {
    let named: string | undefined;
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node)) && node.name)
      named = node.name.getText();
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) named = node.name.text;
    if (named) anchor.push(named);

    if (ts.isJsxElement(node)) jsxElement(node.openingElement, node.children);
    else if (ts.isJsxSelfClosingElement(node)) jsxElement(node, []);
    else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
      const [first, second] = node.arguments;
      if (isFactory(callee)) factoryElement(node);
      // document.createElement: the element counts once it is in the page.
      else if (method === 'createElement' && first && ts.isStringLiteralLike(first) && tagRule(first.text)) {
        const parent = node.parent;
        if (
          ts.isCallExpression(parent) &&
          insertions.has(ts.isPropertyAccessExpression(parent.expression) ? parent.expression.name.text : '')
        )
          add(node, tagRule(first.text)!, `createElement('${first.text}') (${hint(first.text)})`);
        else if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
          const tag = first.text;
          created.set(parent.name.text, {
            file,
            line: lineOf(source, node),
            rule: tagRule(tag)!,
            detail: `createElement('${tag}') (${hint(tag)})`,
            anchor: [...anchor],
          });
        }
      }
      if (insertions.has(method)) for (const arg of node.arguments) if (ts.isIdentifier(arg)) inserted.add(arg.text);
      if (
        method === 'setAttribute' &&
        first &&
        ts.isStringLiteralLike(first) &&
        first.text === 'role' &&
        second &&
        ts.isStringLiteralLike(second) &&
        widgetRoles.has(second.text)
      )
        add(node, 'widget-role', `setAttribute('role', '${second.text}')`);
      if (method === 'insertAdjacentHTML') add(node, 'raw-html', 'insertAdjacentHTML');
      // CSS written in a script, through the CSSOM: rules, whole sheets and an element's own style.
      if (method === 'insertRule' || method === 'replaceSync') add(node, 'inline-style', `${method}(...)`);
      if (method === 'setProperty' && ts.isPropertyAccessExpression(callee) && isStyleObject(callee.expression))
        add(node, 'inline-style', '.style.setProperty(...)');
      if (method === 'setAttribute' && first && ts.isStringLiteralLike(first) && first.text.toLowerCase() === 'style')
        add(node, 'inline-style', "setAttribute('style', ...)");
      if (callee.getText() === 'Object.assign' && first && isStyleObject(first)) add(node, 'inline-style', 'Object.assign(.style, ...)');
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
    ) {
      const property = ts.isPropertyAccessExpression(node.left) ? node.left.name.text : undefined;
      if (property === 'innerHTML' || property === 'outerHTML') add(node, 'raw-html', `${property} =`);
      // el.style = ..., el.style.color = ..., el.style[name] = ... (cssText is reported where it is named).
      else if (property !== 'cssText' && (isStyleObject(node.left) || isStyleObject(node.left.expression)))
        add(node, 'inline-style', `${node.left.getText().slice(0, 40)} =`);
    }
    if (ts.isPropertyAccessExpression(node) && (node.name.text === 'cssText' || node.name.text === 'adoptedStyleSheets'))
      add(node, 'inline-style', node.name.text);
    ts.forEachChild(node, visit);
    if (named) anchor.pop();
  };
  visit(source);
  for (const [name, violation] of created) if (inserted.has(name)) out.push(violation);
  return out;
}

/**
 * Decodes CSS escapes (`\67 ` is `g`, `\:` is `:`) outside quoted strings, so `r\67 b(...)` and
 * `!impor\74 ant` are checked as what they mean. In a selector (`ident`), an escaped character that cannot
 * stand in a name becomes `_`, so `.w-1\/2` stays one class name.
 */
export function unescapeCss(text: string, ident = false): string {
  if (!text.includes('\\')) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"' || char === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== char) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (char !== '\\' || i + 1 >= text.length) {
      out += char;
      continue;
    }
    const hex = /^([0-9a-f]{1,6})[ \t\n\r\f]?/i.exec(text.slice(i + 1, i + 8));
    const code = hex ? parseInt(hex[1]!, 16) : text.codePointAt(i + 1)!;
    const decoded = hex && (code === 0 || code > 0x10ffff) ? '\ufffd' : String.fromCodePoint(code);
    out += ident && !/[\w-]/.test(decoded) ? '_' : decoded;
    i += hex ? hex[0].length : decoded.length;
  }
  return out;
}

type CssItem = { kind: 'prelude' | 'statement'; line: number; text: string; anchor: string[]; layout: boolean };

const layoutComment = /^\/\*\s*layout\s*\*\/$/;

/**
 * Splits CSS into preludes (selectors and at-rule heads, before `{`) and statements (ending in `;`
 * or `}`); comments become spaces. A `/* layout *\/` comment inside a statement, or right after it
 * on the same line, marks it as layout.
 */
function cssItems(css: string): { items: CssItem[]; layoutComments: number } {
  const items: CssItem[] = [];
  const stack: string[] = [];
  let buffer = '';
  let start = 0;
  let line = 1;
  let depth = 0;
  let layout = false;
  let layoutComments = 0;
  let last: { item: CssItem; line: number } | undefined;
  const flush = (kind: CssItem['kind']) => {
    const text = unescapeCss(buffer.trim(), kind === 'prelude');
    if (text) {
      const item = { kind, line: start, text, anchor: [...stack], layout };
      items.push(item);
      if (kind === 'statement') last = { item, line };
    }
    if (kind === 'prelude') stack.push(text);
    buffer = '';
    start = 0;
    layout = false;
  };
  for (let i = 0; i < css.length; i++) {
    const char = css[i]!;
    if (char === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const comment = css.slice(i, end === -1 ? css.length : end + 2);
      if (layoutComment.test(comment)) {
        layoutComments++;
        if (buffer.trim()) layout = true;
        else if (last && last.line === line) last.item.layout = true;
      }
      line += comment.split('\n').length - 1;
      buffer += ' ';
      i += comment.length - 1;
      continue;
    }
    if (char === '"' || char === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== char) j += css[j] === '\\' ? 2 : 1;
      const string = css.slice(i, j + 1);
      if (!start) start = line;
      buffer += string;
      line += string.split('\n').length - 1;
      i = j;
      continue;
    }
    if (char === '\n') line++;
    if (char === '(') depth++;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (char === '{' || char === ';' || char === '}')) {
      flush(char === '{' ? 'prelude' : 'statement');
      if (char === '}') stack.pop();
      continue;
    }
    if (!start && char.trim()) start = line;
    buffer += char;
  }
  flush('statement');
  return { items, layoutComments };
}

/** The custom property an `@property` prelude registers. */
const registered = (prelude: string | undefined) => (prelude && /^@property\s+(--[\w-]+)$/i.exec(prelude)?.[1]) || undefined;

/**
 * Every declaration. Inside `@property --x`, `initial-value` is read as a definition of `--x` (so it is checked
 * as one) and the other descriptors are left out; a `--muxui-*` registration is reported whole instead.
 */
function declarations(css: string) {
  return cssItems(css).items.flatMap(({ kind, line, text, anchor, layout }) => {
    const colon = text.indexOf(':');
    if (kind !== 'statement' || text.startsWith('@') || colon === -1) return [];
    const name = text.slice(0, colon).trim();
    const registration = registered(anchor.at(-1));
    if (registration && (registration.startsWith('--muxui-') || name.toLowerCase() !== 'initial-value')) return [];
    const property = registration ?? (name.startsWith('--') ? name : name.toLowerCase());
    const raw = text.slice(colon + 1);
    const important = /!\s*important\s*$/i.test(raw);
    return [{ line, property, value: raw.replace(/!\s*important\s*$/i, '').trim(), text, anchor, layout, important }];
  });
}

/** A set of custom property names, or a test for one. */
export type Names = { has(name: string): boolean };

const cssWide = /^(inherit|initial|unset|revert|revert-layer)$/i;
const keywords = new Set(['none', 'inset', 'normal', 'bold', 'bolder', 'lighter', 'italic', 'oblique', 'small-caps']);
// Any --pb-* or local name: used where a value only has to be a reference (inline style custom properties).
const anyAlias: Names = { has: (name) => name.startsWith('--') };

/**
 * Replaces each var() with its fallback, so a fallback is checked as part of the value it stands in for,
 * or with `mark` when it has none; a var() of a name that is no Mux token or allowed alias also leaves
 * `untokened--name`.
 */
function replaceTokens(value: string, aliases: Names, mark = ' '): string {
  let rest = value;
  // The last var( holds no other, so the innermost resolve first and a fallback's own var()s before it.
  for (let start = lastVar(rest); start !== -1; start = lastVar(rest)) {
    let depth = 1;
    let end = start + 4;
    for (; end < rest.length && depth; end++) depth += rest[end] === '(' ? 1 : rest[end] === ')' ? -1 : 0;
    const inner = rest.slice(start + 4, depth ? end : end - 1);
    const comma = inner.indexOf(',');
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma === -1 ? '' : inner.slice(comma + 1).trim();
    const token = /^--[\w-]+$/.test(name) && (name.startsWith('--muxui-') || aliases.has(name));
    rest = `${rest.slice(0, start)}${token ? '' : ` untokened${name}`} ${fallback || mark} ${rest.slice(end)}`;
  }
  return rest;
}

const lastVar = (text: string) => [...text.matchAll(/(?<![\w-])var\(/gi)].at(-1)?.index ?? -1;

/** A value's parts at the top level: split at spaces and slashes (kept as `/`), never inside parentheses. */
function topLevelParts(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let part = '';
  for (const char of value) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (depth === 0 && (/\s/.test(char) || char === '/')) {
      if (part) parts.push(part);
      if (char === '/') parts.push('/');
      part = '';
    } else part += char;
  }
  if (part) parts.push(part);
  return parts;
}

/** What a `font` shorthand writes by hand for weight (a number or weight keyword before the size) and line height (after `/`). */
function fontShorthand(value: string, aliases: Names) {
  const parts = topLevelParts(value);
  const slash = parts.indexOf('/');
  const weight = parts
    .slice(0, slash === -1 ? undefined : slash)
    .map((part) => replaceTokens(part, aliases).trim())
    .filter((part) => /^(bold|bolder|lighter|[+-]?(\d+\.?\d*|\.\d+))$/i.test(part));
  const lineHeight = slash === -1 ? [] : literals(parts[slash + 1] ?? '', aliases);
  return { weight, lineHeight };
}

/** The parts of a value that are not Mux tokens, allowed aliases, zero, unitless numbers or neutral keywords. */
export function handWritten(value: string, aliases: Names): string[] {
  if (cssWide.test(value.trim())) return [];
  const rest = replaceTokens(value, aliases)
    .replace(/\b(calc|min|max|clamp)\(/g, ' ')
    .replace(/[()*+/,]/g, ' ');
  return (rest.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).filter((part) => {
    if (part === '-' || keywords.has(part.toLowerCase())) return false;
    const number = /^[+-]?(\d+\.?\d*|\.\d+)([a-z%]*)$/i.exec(part);
    return !(number && (!number[2] || Number(number[1]) === 0));
  });
}

const neutral: ReadonlySet<string> = new Set(['auto', 'normal', 'none']);
const mathFunctions = new Set(['calc', 'min', 'max', 'clamp']);

/**
 * The literal parts of a value that must be a token (spacing, weight, line height, letter spacing):
 * anything but Mux tokens, allowed aliases, zero, `auto`, `normal`, `none`, a CSS-wide keyword, or
 * calc/min/max/clamp of tokens (where unitless factors are allowed, as in `calc(-1 * var(--x))`).
 */
export function literals(value: string, aliases: Names): string[] {
  if (cssWide.test(value.trim())) return [];
  const parts = replaceTokens(value, aliases).match(/[\w-]+\(|[(),/*+]|[^\s(),/*+]+/g) ?? [];
  const out: string[] = [];
  const stack: ('math' | 'skip' | 'group')[] = [];
  for (const part of parts) {
    const inside = stack.at(-1);
    if (part === ')') {
      stack.pop();
      continue;
    }
    if (inside === 'skip') {
      if (part.endsWith('(')) stack.push('skip');
      continue;
    }
    if (part.endsWith('(')) {
      const name = part.slice(0, -1).toLowerCase();
      if (part === '(') stack.push(inside === 'math' ? 'math' : 'group');
      else if (mathFunctions.has(name)) stack.push('math');
      else {
        out.push(`${name}()`);
        stack.push('skip');
      }
      continue;
    }
    if (part === ',' || part === '/' || part === '*' || part === '+' || part === '-') continue;
    const number = /^[+-]?(\d+\.?\d*|\.\d+)([a-z%]*)$/i.exec(part);
    if (number) {
      if (Number(number[1]) === 0 || (inside === 'math' && !number[2])) continue;
      out.push(part);
      continue;
    }
    if (neutral.has(part.toLowerCase())) continue;
    out.push(part);
  }
  return out;
}

const easing = /(?<![\w-])(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|cubic-bezier|steps)(?![\w-])/gi;
const duration = /(?<![\w.-])[+-]?(\d+\.?\d*|\.\d+)m?s(?![\w-])/gi;

/** Durations and easings in a transition or animation value that are literals rather than tokens. */
export function motionLiterals(value: string, aliases: Names): string[] {
  const rest = replaceTokens(value, aliases);
  const out = [...rest.matchAll(duration)].filter((match) => Number(match[1]) !== 0).map((match) => match[0]);
  out.push(...[...rest.matchAll(easing)].map((match) => match[0]));
  out.push(...(rest.match(/untokened--[\w-]+/g) ?? []));
  return out;
}

// CSS named colours other than transparent and currentColor (which name no colour).
const namedColours = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue ' +
    'chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey ' +
    'darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray ' +
    'darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen ' +
    'fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen ' +
    'lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime ' +
    'limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue ' +
    'mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive ' +
    'olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum ' +
    'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver ' +
    'skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white ' +
    'whitesmoke yellow yellowgreen'
  ).split(' '),
);

/** The colour literal in a value, if any: hex, a colour function or a named colour. */
export function colourLiteral(value: string): string | undefined {
  const bare = value
    .replace(/"[^"]*"|'[^']*'/g, ' ')
    .replace(/url\([^)]*\)/gi, ' ')
    .replace(/--[\w-]+/g, ' ');
  const literal = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i.exec(bare);
  if (literal) return literal[0];
  return bare.match(/-?[a-z_][\w-]*/gi)?.find((word) => namedColours.has(word.toLowerCase()));
}

/**
 * Custom properties a stylesheet defines purely from Mux tokens (and `known` aliases), every
 * definition, one level deep. For tokens.css (no `known`) these are the --pb-* aliases; for any
 * other file, its own local names built from tokens and those aliases.
 */
export function pureAliases(css: string, known?: ReadonlySet<string>): Set<string> {
  const pure = new Map<string, boolean>();
  for (const { property, value } of declarations(css)) {
    if (known ? !property.startsWith('--') || property.startsWith('--muxui-') : !property.startsWith('--pb-')) continue;
    const fromTokens = (known ? /var\(/ : /var\(\s*--muxui-/).test(value) && handWritten(value, known ?? new Set()).length === 0;
    pure.set(property, (pure.get(property) ?? true) && fromTokens);
  }
  return new Set([...pure].filter(([, ok]) => ok).map(([name]) => name));
}

/** Every custom property a stylesheet defines. */
export function definedProperties(css: string): Set<string> {
  const names = new Set<string>();
  for (const { property } of declarations(css)) if (property.startsWith('--')) names.add(property);
  for (const match of css.matchAll(/@property\s+(--[\w-]+)/g)) names.add(match[1]!);
  return names;
}

/** The contents of one file in a .tgz (a plain ustar archive, as npm packs it). */
export function tarFile(tgz: Uint8Array, name: string): string | undefined {
  const tar = gunzipSync(tgz);
  const field = (header: Buffer, start: number, length: number) =>
    header
      .subarray(start, start + length)
      .toString('utf8')
      .replace(/\0[\s\S]*$/, '');
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const prefix = field(header, 345, 155);
    const entry = (prefix ? `${prefix}/` : '') + field(header, 0, 100);
    const size = parseInt(field(header, 124, 12).trim() || '0', 8);
    const type = field(header, 156, 1);
    offset += 512;
    if (entry === name && (type === '0' || type === '')) return tar.subarray(offset, offset + size).toString('utf8');
    offset += Math.ceil(size / 512) * 512;
  }
  return undefined;
}

/** The tarball path a package.json gives `@muxui/react` as `file:`, resolved from packages/ui. */
export function vendoredTarball(packageJson: string): string {
  const spec = (JSON.parse(packageJson) as { dependencies?: Record<string, string> }).dependencies?.['@muxui/react'];
  if (!spec?.startsWith('file:') || !spec.endsWith('.tgz')) {
    throw new Error(`mux-guard: packages/ui/package.json must take @muxui/react from a file: tarball, not ${spec}`);
  }
  return join(root, 'packages/ui', spec.slice('file:'.length));
}

let muxTokenCache: Set<string> | undefined;

/** The custom properties Mux UI's stylesheet defines, read once per run from the vendored tarball. */
export function muxTokens(tarball = muxTarball): Set<string> {
  if (muxTokenCache && tarball === muxTarball) return muxTokenCache;
  const css = tarFile(readFileSync(tarball), 'package/generated/styles.css');
  if (css === undefined) throw new Error(`mux-guard: no package/generated/styles.css in ${tarball}`);
  const tokens = new Set(
    [...css.matchAll(/(--muxui-[\w-]+)\s*:/g), ...css.matchAll(/@property\s+(--muxui-[\w-]+)/g)].map((match) => match[1]!),
  );
  if (tarball === muxTarball) muxTokenCache = tokens;
  return tokens;
}

/**
 * What a stylesheet is checked against: tokens.css's pure aliases, every name Mux and tokens.css define, and Mux's
 * own tokens alone (`mux`), which tell a real Mux token from a --muxui-* name the app made up.
 */
export type CssContext = { aliases: ReadonlySet<string>; defined: Names; mux: Names };

/**
 * Whether a custom property's value is built from tokens: var()s of Mux tokens or `aliases` with nothing
 * hand-written beside them (maths over them is fine), or a bare 0, none, auto, normal or CSS-wide keyword.
 */
function fromTokens(value: string, aliases: Names): boolean {
  const bare = value.trim();
  if (cssWide.test(bare) || /^(0|none|auto|normal)$/i.test(bare)) return true;
  return /var\(/.test(bare) && handWritten(bare, aliases).length === 0;
}

const sized = /^[+-]?(\d+\.?\d*|\.\d+)[a-z%]+$/i;
const spacingProperty = /^(padding|margin)(-[a-z]+)*$|^(gap|row-gap|column-gap)$/;
const motionProperty = /^(transition|animation)(-(duration|timing-function|delay))?$/;

/** The index just past the `)` that closes the parenthesis opened before `from`. */
function closing(text: string, from: number): number {
  let depth = 1;
  let end = from;
  for (; end < text.length && depth; end++) depth += text[end] === '(' ? 1 : text[end] === ')' ? -1 : 0;
  return end;
}

/** A selector list's branches: split at its top-level commas. */
export function selectorBranches(list: string): string[] {
  const branches: string[] = [];
  let depth = 0;
  let branch = '';
  for (const char of list) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      branches.push(branch.trim());
      branch = '';
    } else branch += char;
  }
  return [...branches, branch.trim()];
}

// Functional pseudo-classes that take a selector list and match an element that matches any branch.
const anyOf = /:(is|where|matches|any|-webkit-any|-moz-any)\(/i;

/** The complex selectors a selector means, each :is() and :where() (and the like) expanded into its branches. */
function expandSelector(selector: string): string[] {
  const match = anyOf.exec(selector);
  if (!match) return [selector];
  const open = match.index + match[0].length;
  const end = closing(selector, open);
  return selectorBranches(selector.slice(open, end - 1)).flatMap((branch) =>
    expandSelector(selector.slice(0, match.index) + branch + selector.slice(end)),
  );
}

/**
 * Type selectors for elements Mux has a component for, outside :not()/:has() and not inside a Mux component's
 * markup: an element counts as inside when its own compound, or a compound it is a descendant or child of,
 * carries a `.muxui-*` class (or a Mux data attribute). A sibling combinator does not put it inside, and each
 * branch of the selector list and of an :is() or :where() must hold on its own.
 */
export function elementSelectors(prelude: string): string[] {
  if (prelude.startsWith('@')) return [];
  let rest = prelude
    .replace(/"[^"]*"|'[^']*'/g, '""')
    .replace(/\[[^\]]*\]/g, (attribute) => (attribute.includes('muxui') ? '.muxui-attribute' : '[]'));
  // :not() and :has() test other elements, so their arguments are not styled.
  for (let match = /:(not|has)\(/i.exec(rest); match; match = /:(not|has)\(/i.exec(rest))
    rest = rest.slice(0, match.index) + rest.slice(closing(rest, match.index + match[0].length));
  const found = new Set<string>();
  for (const selector of selectorBranches(rest).flatMap(expandSelector)) {
    // Other functional pseudo-classes and elements (:nth-child(2n + 1), ::part(x)) hold no element of their own.
    let plain = selector;
    for (let match = /:[\w-]+\((?!\))/.exec(plain); match; match = /:[\w-]+\((?!\))/.exec(plain))
      plain = `${plain.slice(0, match.index + match[0].length)}${plain.slice(closing(plain, match.index + match[0].length) - 1)}`;
    // Compounds at even indexes, the combinator before each at the odd one (undefined for a descendant).
    const parts = plain.trim().split(/\s*([>+~])\s*|\s+/);
    let ancestorMux = false;
    let previousMux = false;
    for (let i = 0; i < parts.length; i += 2) {
      const compound = parts[i] ?? '';
      if (i > 0 && parts[i - 1] !== '+' && parts[i - 1] !== '~') ancestorMux ||= previousMux;
      const ownMux = compound.includes('.muxui-');
      const type = /^[a-z][a-z0-9]*/i.exec(compound)?.[0].toLowerCase();
      // <svg> and <time> exist only in icons.tsx and time.tsx (the script rules see to that), so styling them by tag is fine.
      if (!ancestorMux && !ownMux && type && type !== 'svg' && type !== 'time' && (type in replacements || textTags.has(type)))
        found.add(type);
      previousMux = ownMux;
    }
  }
  return [...found];
}

/** Scans a stylesheet for every CSS rule; `layout` counts the /* layout *\/ comments and those that waived a spacing value. */
export function scanCss(
  file: string,
  css: string,
  context: CssContext,
): { violations: Violation[]; layout: { comments: number; used: number } } {
  const out: Violation[] = [];
  const add = (line: number, rule: Rule, detail: string, anchor: string[]) =>
    out.push({ file, line, rule, detail: detail.replace(/\s+/g, ' '), anchor });
  const { items, layoutComments } = cssItems(css);
  let layoutUsed = 0;
  for (const { kind, line, text, anchor } of items) {
    const specifier = kind === 'statement' ? /^@import\s+(?:url\(\s*)?(['"]?)([^'"()\s]+)\1/i.exec(text)?.[2] : undefined;
    if (specifier && isMux(specifier) && !file.startsWith('packages/ui/src/')) add(line, 'mux-import', text, anchor);
    else if (specifier && unreadImport(file, specifier)) add(line, 'css-import', `${text} is a stylesheet the guard does not read`, anchor);
    // The stylesheet that imports Mux's own is read only for this: it holds nothing but imports and layer order.
    if (file === muxStylesheet && !(kind === 'statement' && !anchor.length && /^@(import|layer)\s/i.test(text)))
      add(line, 'css-mux-stylesheet', `${text} (${muxStylesheet} holds only @import and @layer statements)`, anchor);
  }
  // Custom properties, whatever their prefix. A name this file sets to anything but tokens is not a token here,
  // even a tokens.css alias. A --muxui-* name Mux does not define is unknown wherever it is set or read, so a
  // local definition does not excuse it. Setting a real Mux token (or an alias) to tokens is how Mux is themed;
  // setting one to anything else is css-token-value.
  const pure = pureAliases(css, context.aliases);
  const literal = new Set(
    declarations(css)
      .filter(({ property, value }) => property.startsWith('--') && !fromTokens(value, context.aliases))
      .map(({ property }) => property),
  );
  const local: Names = { has: (name) => !literal.has(name) && (context.aliases.has(name) || pure.has(name)) };
  const own = definedProperties(css);
  const made = (name: string) => name.startsWith('--muxui-') && !context.mux.has(name);
  for (const { kind, line, text, anchor } of items) {
    if (kind !== 'prelude') continue;
    const registration = registered(text);
    if (registration?.startsWith('--muxui-'))
      add(
        line,
        made(registration) ? 'css-unknown-token' : 'css-token-value',
        `${text} (${made(registration) ? 'not a Mux UI token' : 'registers a Mux UI token again'})`,
        anchor,
      );
    const elements = elementSelectors(text);
    if (elements.length)
      add(
        line,
        'css-element-selector',
        `${text} (${elements.map((tag) => `${tag}: ${textTags.has(tag) ? 'Text' : replacements[tag]}`).join(', ')})`,
        anchor,
      );
    if (elements.length) out.at(-1)!.selector = text;
  }
  for (const { line, property, value, text, anchor, layout, important } of declarations(css)) {
    const where = [...anchor];
    const first = out.length;
    if (colourLiteral(value)) add(line, 'css-colour', text, where);
    if (/^border(-[a-z]+)*-radius$/.test(property) && handWritten(value, local).length) add(line, 'css-radius', text, where);
    if ((property === 'box-shadow' || property === 'text-shadow') && handWritten(value, local).length) add(line, 'css-shadow', text, where);
    if (property === 'font-family' && handWritten(value, local).length) add(line, 'css-font-family', text, where);
    if (property === 'font-size' && handWritten(value, local).length) add(line, 'css-font-size', text, where);
    if (property === 'font') {
      // The shorthand sets both: a part with a unit is a size, any other leftover a family.
      const parts = handWritten(value, local);
      if (parts.some((part) => sized.test(part))) add(line, 'css-font-size', text, where);
      if (parts.some((part) => !sized.test(part))) add(line, 'css-font-family', text, where);
      const written = fontShorthand(value, local);
      if (written.weight.length) add(line, 'css-font-weight', text, where);
      if (written.lineHeight.length) add(line, 'css-line-height', text, where);
    }
    if (property === 'font-weight' && literals(value, local).length) add(line, 'css-font-weight', text, where);
    if (property === 'line-height' && literals(value, local).length) add(line, 'css-line-height', text, where);
    if (property === 'letter-spacing' && literals(value, local).length) add(line, 'css-letter-spacing', text, where);
    if (spacingProperty.test(property) && literals(value, local).length) {
      if (layout) layoutUsed++;
      else add(line, 'css-spacing', text, where);
    }
    if (motionProperty.test(property) && motionLiterals(value, local).length) add(line, 'css-motion', text, where);
    if (/^animation(-iteration-count)?$/.test(property) && /(?<![\w-])infinite(?![\w-])/i.test(value))
      add(line, 'css-infinite', text, where);
    if (important) add(line, 'css-important', text, where);
    if (/^(backdrop-)?filter$/.test(property) && /\bblur\(/i.test(value)) add(line, 'css-blur', text, where);
    if (made(property)) add(line, 'css-unknown-token', `${property} is not a Mux UI token, in ${text}`, where);
    else if (
      property.startsWith('--') &&
      (context.mux.has(property) || context.aliases.has(property)) &&
      !fromTokens(value, local) &&
      !colourLiteral(value)
    )
      add(line, 'css-token-value', text, where);
    for (const match of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
      const name = match[1]!;
      if (made(name) || (!context.defined.has(name) && !own.has(name))) add(line, 'css-unknown-token', `var(${name}) in ${text}`, where);
    }
    for (const violation of out.slice(first)) violation.value = value;
  }
  return { violations: out, layout: { comments: layoutComments, used: layoutUsed } };
}

export function count(violations: Violation[]): Counts {
  const counts: Counts = {};
  for (const { file, rule } of violations) {
    const perFile = (counts[file] ??= {});
    perFile[rule] = (perFile[rule] ?? 0) + 1;
  }
  return counts;
}

/** Each file and rule whose count rose above the baseline (a file missing from it counts as zero). */
export function regressions(counts: Counts, baseline: Counts) {
  return Object.entries(counts).flatMap(([file, perFile]) =>
    rules.flatMap((rule) => {
      const now = perFile[rule] ?? 0;
      const before = baseline[file]?.[rule] ?? 0;
      return now > before ? [{ file, rule, before, now }] : [];
    }),
  );
}

export const areas = [
  'shell',
  'feed',
  'thread',
  'community',
  'profile',
  'auth',
  'settings',
  'composer',
  'moderation',
  'admin',
  'shared ui',
] as const;
const routeAreas: Record<string, (typeof areas)[number]> = {
  index: 'feed',
  all: 'feed',
  local: 'feed',
  popular: 'feed',
  moderating: 'feed',
  post: 'thread',
  c: 'community',
  communities: 'community',
  resolve: 'community',
  u: 'profile',
  notifications: 'profile',
  auth: 'auth',
  invite: 'auth',
  settings: 'settings',
  submit: 'composer',
  modlog: 'moderation',
  report: 'moderation',
  admin: 'admin',
  kit: 'shared ui',
};

/** The product area a file belongs to. Route files outside a known folder, and the rest of web, are the shell. */
export function area(file: string): (typeof areas)[number] {
  if (file.startsWith('packages/ui/src/composer/')) return 'composer';
  if (file.startsWith('packages/ui/') || file.startsWith('tools/')) return 'shared ui';
  const route = /^packages\/web\/src\/routes\/([^/]+)\//.exec(file)?.[1];
  return (route && routeAreas[route]) || 'shell';
}

const isTestOrFixture = (file: string) => /\.test\.[cm]?[jt]sx?$|(^|\/)__fixtures__\//.test(file);

/**
 * A written exception. `match` is a substring of the violation's text (for a type selector, of every branch of
 * its selector list); `anchor` an enclosing component, function or CSS prelude; `value` a CSS declaration's
 * exact value; `condition` an enclosing at-rule's prelude, such as a media query.
 */
export type Exception = {
  file: string;
  rule: Rule;
  match: string;
  anchor?: string;
  value?: string;
  condition?: string;
  count?: number;
  reason: string;
};

function isException(entry: unknown): entry is Exception {
  if (typeof entry !== 'object' || entry === null) return false;
  const { file, rule, match, anchor, value, condition, count, reason } = entry as Record<string, unknown>;
  return (
    typeof file === 'string' &&
    rules.some((known) => known === rule) &&
    typeof match === 'string' &&
    match !== '' &&
    typeof reason === 'string' &&
    reason.trim() !== '' &&
    (anchor === undefined || typeof anchor === 'string') &&
    (value === undefined || typeof value === 'string') &&
    (condition === undefined || (typeof condition === 'string' && condition.startsWith('@'))) &&
    (count === undefined || (typeof count === 'number' && Number.isInteger(count) && count > 0))
  );
}

/** Reads and checks the exceptions file: every entry needs a file, a known rule, a match and a reason. */
export function parseExceptions(json: string): Exception[] {
  const entries: unknown = JSON.parse(json);
  if (!Array.isArray(entries)) throw new Error('mux-guard: the exceptions file must be an array');
  entries.forEach((entry: unknown, index) => {
    if (!isException(entry))
      throw new Error(
        `mux-guard: exception ${index} needs file, a known rule, match and reason (anchor, value, an @ condition and count optional)`,
      );
  });
  return entries;
}

const matches = (exception: Exception, v: Violation) =>
  v.file === exception.file &&
  v.rule === exception.rule &&
  v.detail.includes(exception.match) &&
  // A selector list's every branch must match on its own, so `.pb-prose a, button` does not pass as `.pb-prose `.
  (v.selector === undefined || selectorBranches(v.selector).every((branch) => branch.includes(exception.match))) &&
  (exception.anchor === undefined || (v.anchor ?? []).includes(exception.anchor)) &&
  (exception.value === undefined || v.value === exception.value) &&
  (exception.condition === undefined || (v.anchor ?? []).includes(exception.condition));

/**
 * Drops the excepted violations. Each exception must match exactly `count` (default 1) violations:
 * none means it is stale, more means it would hide new code.
 */
export function applyExceptions(violations: Violation[], exceptions: Exception[]) {
  const problems: string[] = [];
  for (const exception of exceptions) {
    const hits = violations.filter((v) => matches(exception, v)).length;
    const expected = exception.count ?? 1;
    if (hits !== expected)
      problems.push(
        `${exception.file} ${exception.rule} "${exception.match}"${exception.anchor ? ` in ${exception.anchor}` : ''} matches ${hits}, expected ${expected}${hits ? '' : ' (stale: remove it)'}`,
      );
  }
  return { kept: violations.filter((v) => !exceptions.some((exception) => matches(exception, v))), problems };
}

/** Every script and stylesheet the build can import, under packages/* and tools/* (see `walked` for what is left out). */
export const scriptGlob = '{packages,tools}/*/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}';
export const cssGlob = '{packages,tools}/*/**/*.css';

/** Every violation in the repository before exceptions, and the /* layout *\/ counts. */
export function scanRepository() {
  const files = (pattern: string) => globSync(pattern, { cwd: root, exclude: (name) => name === 'node_modules' }).filter(walked);
  const tokensCss = readFileSync(join(root, tokensFile), 'utf8');
  const context: CssContext = {
    aliases: pureAliases(tokensCss),
    defined: new Set([...muxTokens(), ...definedProperties(tokensCss)]),
    mux: muxTokens(),
  };
  const layout = { comments: 0, used: 0 };
  const violations = [
    ...files(scriptGlob).flatMap((file) => scanScript(file, readFileSync(join(root, file), 'utf8'))),
    ...files(cssGlob).flatMap((file) => {
      const found = scanCss(file, readFileSync(join(root, file), 'utf8'), context);
      layout.comments += found.layout.comments;
      layout.used += found.layout.used;
      return found.violations;
    }),
  ];
  const order = (v: Violation) => areas.indexOf(area(v.file));
  violations.sort(
    (a, b) => order(a) - order(b) || a.file.localeCompare(b.file) || a.line - b.line || rules.indexOf(a.rule) - rules.indexOf(b.rule),
  );
  return { violations, layout };
}

function readBaseline(): Counts {
  try {
    return JSON.parse(readFileSync(baselinePath, 'utf8')) as Counts;
  } catch {
    return {};
  }
}

const tally = <T extends string>(items: T[]) => {
  const totals = new Map<T, number>();
  for (const item of items) totals.set(item, (totals.get(item) ?? 0) + 1);
  return totals;
};
const summary = (totals: Map<string, number>) => [...totals].map(([key, value]) => `${key} ${value}`).join(', ');

function main() {
  const args = new Set(process.argv.slice(2));
  const scanned = scanRepository();
  const exceptions = parseExceptions(readFileSync(exceptionsPath, 'utf8'));
  const { kept: violations, problems } = applyExceptions(scanned.violations, exceptions);
  const counts = count(violations);
  for (const problem of problems) console.error(`mux-guard: exception ${problem}`);
  if (problems.length) process.exitCode = 1;

  if (args.has('--baseline')) {
    const sorted = Object.fromEntries(
      Object.keys(counts)
        .sort()
        .map((file) => [file, counts[file]]),
    );
    writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`mux-guard: wrote the baseline, ${violations.length} violations in ${Object.keys(counts).length} files`);
    return;
  }

  for (const name of areas) {
    const inArea = violations.filter((v) => area(v.file) === name);
    if (!inArea.length) continue;
    console.log(`\n${name}: ${inArea.length} (${summary(tally(inArea.map((v) => v.rule)))})`);
    for (const v of inArea) console.log(`  ${v.file}:${v.line} ${v.rule}: ${v.detail.slice(0, 120)}`);
  }
  const width = Math.max(...rules.map((rule) => rule.length), ...areas.map((name) => name.length));
  console.log('\nTotals by rule');
  const byRule = tally(violations.map((v) => v.rule));
  for (const rule of rules) console.log(`  ${rule.padEnd(width)}  ${byRule.get(rule) ?? 0}`);
  console.log('\nTotals by area');
  const byArea = tally(violations.map((v) => area(v.file)));
  for (const name of areas) console.log(`  ${name.padEnd(width)}  ${byArea.get(name) ?? 0}`);
  console.log(
    `\nmux-guard: ${violations.length} violations in ${Object.keys(counts).length} files; ` +
      `${exceptions.length} exceptions hide ${scanned.violations.length - violations.length}; ` +
      `${scanned.layout.comments} /* layout */ comments (${scanned.layout.used} waive a spacing value)`,
  );

  if (args.has('--enforce')) {
    if (violations.length) process.exitCode = 1;
    return;
  }
  const baseline = readBaseline();
  const worse = regressions(counts, baseline);
  for (const r of worse)
    console.error(`mux-guard: ${r.file} ${r.rule} rose from ${r.before} to ${r.now} (baseline scripts/mux-guard.baseline.json)`);
  if (worse.length) {
    process.exitCode = 1;
    return;
  }
  const better = Object.keys(baseline).some((file) => rules.some((rule) => (counts[file]?.[rule] ?? 0) < (baseline[file]?.[rule] ?? 0)));
  if (better) console.log('mux-guard: some files improved; `node scripts/mux-guard.ts --baseline` lowers the baseline');
}

if (import.meta.main) main();
