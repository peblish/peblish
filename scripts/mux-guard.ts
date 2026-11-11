// The Mux UI guard: reports UI code that bypasses Mux UI (rules 1 to 5 of the Mux restyle).
//
//   node scripts/mux-guard.ts             report; fails only if a file got worse than the baseline
//   node scripts/mux-guard.ts --enforce   fails on any violation
//   node scripts/mux-guard.ts --baseline  writes the current counts to mux-guard.baseline.json
//
// Rules: raw-element (a raw JSX control or structural element Mux UI has a component for,
// outside a facade wrapper, which is a file that imports @muxui/react), mux-import (@muxui/react
// imported outside packages/ui/src), and in CSS: css-colour (a colour literal), css-radius,
// css-shadow, css-font-family and css-font-size (a value that does not come from a Mux token).
import { globSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export const rules = ['raw-element', 'mux-import', 'css-colour', 'css-radius', 'css-shadow', 'css-font-family', 'css-font-size'] as const;
export type Rule = (typeof rules)[number];

// Files exempt from some rules, each with its reason. Paths are relative to the repository root.
const allow: { file: string; rules: Rule[]; reason: string }[] = [];

const root = join(import.meta.dirname, '..');
const baselinePath = join(import.meta.dirname, 'mux-guard.baseline.json');
const tokensFile = 'packages/ui/src/tokens/tokens.css';
// The file that imports Mux UI's own stylesheet and nothing else.
const muxStylesheet = 'packages/ui/src/styles.css';

export type Violation = { file: string; line: number; rule: Rule; detail: string };
export type Counts = Record<string, Partial<Record<Rule, number>>>;

const rawElements = new Set('button input select textarea dialog table thead tbody tr td th details summary progress meter hr'.split(' '));

const isMux = (specifier: string) => specifier === '@muxui/react' || specifier.startsWith('@muxui/react/');

/** Lines of every import, export-from, dynamic import or import type of @muxui/react. */
function muxImportLines(source: ts.SourceFile): number[] {
  const lines: number[] = [];
  const add = (node: ts.Node, specifier: ts.Node | undefined) => {
    if (specifier && ts.isStringLiteralLike(specifier) && isMux(specifier.text)) {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
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
  return lines;
}

/** Scans a .ts or .tsx file: mux-import outside packages/ui/src, raw-element in .tsx outside facade wrappers. */
export function scanScript(file: string, text: string): Violation[] {
  const tsx = file.endsWith('.tsx');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const imports = muxImportLines(source);
  const out: Violation[] = [];
  if (!file.startsWith('packages/ui/src/')) {
    for (const line of imports) out.push({ file, line, rule: 'mux-import', detail: '@muxui/react' });
  }
  if (!tsx || imports.length > 0) return out;
  const visit = (node: ts.Node): void => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName)) {
      const tag = node.tagName.text;
      if (rawElements.has(tag)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        out.push({ file, line, rule: 'raw-element', detail: `<${tag}>` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

type Statement = { line: number; text: string };

/** Splits CSS into statements that end in `;` or `}` (declarations and at-rule statements); comments become spaces. */
function cssStatements(css: string): Statement[] {
  const out: Statement[] = [];
  let buffer = '';
  let start = 0;
  let line = 1;
  let depth = 0;
  const flush = (keep: boolean) => {
    if (keep && buffer.trim()) out.push({ line: start, text: buffer.trim() });
    buffer = '';
    start = 0;
  };
  for (let i = 0; i < css.length; i++) {
    const char = css[i]!;
    if (char === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const comment = css.slice(i, end === -1 ? css.length : end + 2);
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
      // A buffer before `{` is a selector or an at-rule prelude.
      flush(char !== '{');
      continue;
    }
    if (!start && char.trim()) start = line;
    buffer += char;
  }
  flush(true);
  return out;
}

function declarations(css: string) {
  return cssStatements(css).flatMap(({ line, text }) => {
    const colon = text.indexOf(':');
    if (text.startsWith('@') || colon === -1) return [];
    const name = text.slice(0, colon).trim();
    const property = name.startsWith('--') ? name : name.toLowerCase();
    return [
      {
        line,
        property,
        value: text
          .slice(colon + 1)
          .replace(/!\s*important\s*$/i, '')
          .trim(),
        text,
      },
    ];
  });
}

const cssWide = /^(inherit|initial|unset|revert|revert-layer)$/i;
const keywords = new Set(['none', 'inset', 'normal', 'bold', 'bolder', 'lighter', 'italic', 'oblique', 'small-caps']);

/** The parts of a value that are not Mux tokens, allowed aliases, zero, unitless numbers or neutral keywords. */
export function handWritten(value: string, aliases: ReadonlySet<string>): string[] {
  if (cssWide.test(value.trim())) return [];
  let rest = value;
  // Innermost var() first, so a fallback that is itself a var() resolves before its parent.
  const innermost = /var\(\s*(--[\w-]+)\s*(?:,[^()]*)?\)/;
  for (let match = innermost.exec(rest); match; match = innermost.exec(rest)) {
    const name = match[1]!;
    const token = name.startsWith('--muxui-') || aliases.has(name);
    rest = rest.slice(0, match.index) + (token ? ' ' : ` untokened${name} `) + rest.slice(match.index + match[0].length);
  }
  rest = rest.replace(/\b(calc|min|max|clamp)\(/g, ' ').replace(/[()*+/,]/g, ' ');
  return (rest.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).filter((part) => {
    if (part === '-' || keywords.has(part.toLowerCase())) return false;
    const number = /^[+-]?(\d+\.?\d*|\.\d+)([a-z%]*)$/i.exec(part);
    return !(number && (!number[2] || Number(number[1]) === 0));
  });
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

/** The --pb-* aliases tokens.css defines purely from Mux tokens (every definition, one level deep). */
export function pureAliases(tokensCss: string): Set<string> {
  const pure = new Map<string, boolean>();
  for (const { property, value } of declarations(tokensCss)) {
    if (!property.startsWith('--pb-')) continue;
    const fromMux = /var\(\s*--muxui-/.test(value) && handWritten(value, new Set()).length === 0;
    pure.set(property, (pure.get(property) ?? true) && fromMux);
  }
  return new Set([...pure].filter(([, ok]) => ok).map(([name]) => name));
}

const sized = /^[+-]?(\d+\.?\d*|\.\d+)[a-z%]+$/i;

/** Scans a stylesheet: Mux imports outside packages/ui/src and hand-written colour, radius, shadow and font values. */
export function scanCss(file: string, css: string, aliases: ReadonlySet<string>): Violation[] {
  const out: Violation[] = [];
  const add = (line: number, rule: Rule, detail: string) => out.push({ file, line, rule, detail: detail.replace(/\s+/g, ' ') });
  if (!file.startsWith('packages/ui/src/')) {
    for (const { line, text } of cssStatements(css)) {
      if (/^@import\s+(url\()?\s*['"]@muxui\/react(\/|['"])/i.test(text)) add(line, 'mux-import', text);
    }
  }
  for (const { line, property, value, text } of declarations(css)) {
    if (colourLiteral(value)) add(line, 'css-colour', text);
    if (/^border(-[a-z]+)*-radius$/.test(property) && handWritten(value, aliases).length) add(line, 'css-radius', text);
    if ((property === 'box-shadow' || property === 'text-shadow') && handWritten(value, aliases).length) add(line, 'css-shadow', text);
    if (property === 'font-family' && handWritten(value, aliases).length) add(line, 'css-font-family', text);
    if (property === 'font-size' && handWritten(value, aliases).length) add(line, 'css-font-size', text);
    if (property === 'font') {
      // The shorthand sets both: a part with a unit is a size, any other leftover a family.
      const parts = handWritten(value, aliases);
      if (parts.some((part) => sized.test(part))) add(line, 'css-font-size', text);
      if (parts.some((part) => !sized.test(part))) add(line, 'css-font-family', text);
    }
  }
  return out;
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

/** Groups a file for the totals: web/shell, web/routes/<folder>, ui/components and so on. */
export function area(file: string): string {
  const [, pkg, , first, second] = file.split('/');
  if (pkg === 'web' && first === 'routes') return second?.includes('.') ? 'web/routes' : `web/routes/${second}`;
  return first?.includes('.') ? `${pkg}` : `${pkg}/${first}`;
}

const isTestOrFixture = (file: string) => /\.test\.tsx?$|(^|\/)__fixtures__\//.test(file);

/** Every violation in the repository, after the allow-list. */
export function scanRepository(): Violation[] {
  const files = (pattern: string) =>
    globSync(pattern, { cwd: root }).filter((file) => !isTestOrFixture(file) && !file.includes('/node_modules/'));
  const aliases = pureAliases(readFileSync(join(root, tokensFile), 'utf8'));
  const violations = [
    ...files('{packages,tools}/*/src/**/*.{ts,tsx}')
      .filter((file) => !file.endsWith('.gen.ts'))
      .flatMap((file) => scanScript(file, readFileSync(join(root, file), 'utf8'))),
    ...files('{packages,tools}/*/src/**/*.css')
      .filter((file) => file !== muxStylesheet)
      .flatMap((file) => {
        const found = scanCss(file, readFileSync(join(root, file), 'utf8'), aliases);
        // Only the ui and web stylesheets are UI; elsewhere only the import rule applies.
        return /^packages\/(ui|web)\/src\//.test(file) ? found : found.filter((v) => v.rule === 'mux-import');
      }),
  ];
  return violations
    .filter((v) => !allow.some((entry) => entry.file === v.file && entry.rules.includes(v.rule)))
    .sort((a, b) => a.file.localeCompare(b.file) || rules.indexOf(a.rule) - rules.indexOf(b.rule) || a.line - b.line);
}

function readBaseline(): Counts {
  try {
    return JSON.parse(readFileSync(baselinePath, 'utf8')) as Counts;
  } catch {
    return {};
  }
}

function totalsTable(title: string, totals: Map<string, number>) {
  const width = Math.max(...[...totals.keys()].map((key) => key.length), title.length);
  console.log(`\n${title}`);
  for (const [key, value] of totals) console.log(`  ${key.padEnd(width)}  ${value}`);
}

function main() {
  const args = new Set(process.argv.slice(2));
  const violations = scanRepository();
  const counts = count(violations);

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

  let current = '';
  for (const v of violations) {
    if (v.file !== current) {
      current = v.file;
      const perFile = counts[v.file]!;
      console.log(`\n${v.file}  ${rules.flatMap((rule) => (perFile[rule] ? [`${rule} ${perFile[rule]}`] : [])).join(', ')}`);
    }
    console.log(`  ${`${v.file}:${v.line}`.padEnd(60)} ${v.rule.padEnd(16)} ${v.detail.slice(0, 80)}`);
  }
  const byRule = new Map(rules.map((rule) => [rule, violations.filter((v) => v.rule === rule).length]));
  const byArea = new Map<string, number>();
  for (const v of violations) byArea.set(area(v.file), (byArea.get(area(v.file)) ?? 0) + 1);
  totalsTable('Totals by rule', byRule);
  totalsTable('Totals by area', new Map([...byArea].sort(([a], [b]) => a.localeCompare(b))));
  console.log(`\nmux-guard: ${violations.length} violations in ${Object.keys(counts).length} files`);

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
