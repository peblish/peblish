import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  applyExceptions,
  area,
  count,
  muxTokens,
  parseExceptions,
  pureAliases,
  regressions,
  scanCss,
  scanScript,
  tarFile,
  type CssContext,
  type Violation,
} from './mux-guard.ts';

const found = (violations: { rule: string; line: number }[]) => violations.map(({ rule, line }) => `${rule}:${line}`);
const lines = (...source: string[]) => source.join('\n');
const tsx = (source: string, file = 'packages/web/src/routes/a.tsx') => found(scanScript(file, source));
const none: CssContext = { aliases: new Set(), defined: new Set() };
const css = (source: string, context: CssContext = none, file = 'packages/web/src/a.css') =>
  found(scanCss(file, source, context).violations);

test('raw-element reports raw controls in JSX, not in strings, comments, components or hidden inputs', () => {
  const source = lines(
    "const label = '<button>';", // 1
    'export const A = () => (', // 2
    '  <div>', // 3
    '    {/* <input> */}', // 4
    '    <button type="button">go</button>', // 5
    '    <Button>ok</Button>', // 6
    '    <input name="q" />', // 7
    '    <table><thead><tr><th>x</th></tr></thead></table>', // 8
    '    <details><summary>more</summary><hr /></details>', // 9
    '    <input type="hidden" name="id" />', // 10
    '    <form method="post"><a href="/x">x</a><img src="/i" alt="" /></form>', // 11
    '    <fieldset><legend>l</legend></fieldset><progress /><meter />', // 12
    '  </div>', // 13
    ');', // 14
  );
  expect(tsx(source)).toEqual([
    'raw-element:5',
    'raw-element:7',
    ...Array(4).fill('raw-element:8'),
    ...Array(3).fill('raw-element:9'),
    'raw-element:11',
    'raw-element:11',
    ...Array(4).fill('raw-element:12'),
  ]);
});

test('<time> and <svg> are allowed only in their own modules', () => {
  const source = 'export const T = () => <span><time dateTime="x" /><svg viewBox="0 0 1 1"><path d="M0 0" /></svg></span>;';
  expect(tsx(source)).toEqual(['raw-element:1', 'raw-element:1']);
  expect(tsx(source, 'packages/ui/src/components/time.tsx')).toEqual(['raw-element:1']);
  expect(tsx(source, 'packages/ui/src/components/icons.tsx')).toEqual(['raw-element:1']);
});

test('text-element reports raw text elements; bare-text reports text straight inside layout markup', () => {
  const source = lines(
    'export const A = () => (', // 1
    '  <section>', // 2
    '    <h2>title</h2><p>body</p><strong>s</strong><code>c</code><br />', // 3
    '    <span>visible</span>', // 4
    "    <div>{t('area', 'key')}</div>", // 5
    '    <span>{`$' + '{count} new`}</span>', // 6
    "    <li>{done ? 'yes' : 'no'}</li>", // 7
    '    <span className="pb-row">', // 8
    '      <Text>inside Text</Text>', // 9
    '      {name}', // 10
    "      {' '}", // 11
    '    </span>', // 12
    '  </section>', // 13
    ');', // 14
  );
  expect(tsx(source)).toEqual([...Array(5).fill('text-element:3'), 'bare-text:4', 'bare-text:5', 'bare-text:6', 'bare-text:7']);
});

test('widget-role and widget-handler report hand-built widgets, not groups or focus targets', () => {
  const source = lines(
    'export const A = () => (', // 1
    '  <>', // 2
    '    <div role="button" onClick={go} />', // 3
    "    <span role={'tab'} tabIndex={0} />", // 4
    '    <div role="group" />', // 5
    '    <div id="main" tabIndex={-1} />', // 6
    '    <li onKeyDown={key} />', // 7
    '    <Button role="tab" onClick={go} />', // 8
    '    <form onKeyDown={submit} />', // 9
    '  </>', // 10
    ');', // 11
    "el.setAttribute('role', 'switch');", // 12
    "el.setAttribute('role', 'group');", // 13
  );
  expect(tsx(source)).toEqual([
    'widget-role:3',
    'widget-handler:3',
    'widget-role:4',
    'widget-handler:4',
    'widget-handler:7',
    'widget-role:12',
  ]);
});

test('inline-style reports colour, type and motion values and spacing that is not 0, auto or a token', () => {
  const source = lines(
    'export const A = () => (', // 1
    '  <>', // 2
    "    <div style={{ display: 'inline', margin: 0, padding: 'var(--muxui-semantic-layout-inset-small)' }} />", // 3
    "    <div style={{ gap: 'auto', inset: '0' }} />", // 4
    "    <div style={{ color: 'var(--muxui-x)' }} />", // 5
    "    <div style={{ paddingLeft: '12px' }} />", // 6
    '    <div style={{ marginTop: depth * 4 }} />', // 7
    '    <Card.Root style={{ borderRadius: 4 }} />', // 8
    "    <div style={{ '--depth': depth }} />", // 9
    "    <div style={{ '--tint': '#f00' }} />", // 10
    '    <div style={styles} />', // 11
    "    <div style={inline ? { display: 'inline', margin: 0 } : undefined} />", // 12
    '  </>', // 13
    ');', // 14
  );
  expect(tsx(source)).toEqual([
    'inline-style:5',
    'inline-style:6',
    'inline-style:7',
    'inline-style:8',
    'inline-style:10',
    'inline-style:11',
  ]);
});

test('raw-html and createElement report HTML made outside React, but not scripts or detached elements', () => {
  const source = lines(
    'export function A() {', // 1
    '  const link = document.createElement("a");', // 2
    '  link.click();', // 3
    '  const control = document.createElement("button");', // 4
    '  spoiler.before(control);', // 5
    '  node.append(document.createElement("p"));', // 6
    '  node.innerHTML = html;', // 7
    '  return <><div dangerouslySetInnerHTML={{ __html: html }} /><script dangerouslySetInnerHTML={{ __html: js }} /></>;', // 8
    '}', // 9
  );
  expect(tsx(source)).toEqual(['text-element:6', 'raw-html:7', 'raw-html:8', 'raw-element:4']);
  expect(scanScript('packages/web/src/routes/a.tsx', source).at(-1)?.anchor).toEqual(['A', 'control']);
});

test('a pure wrapper is skipped; a composed piece that imports @muxui/react is checked', () => {
  const wrapper = lines('// A wrapper.', "export { Card } from '@muxui/react';", "export type { CardProps } from '@muxui/react';");
  expect(tsx(wrapper, 'packages/ui/src/components/card.tsx')).toEqual([]);
  const composed = lines("import { Card } from '@muxui/react';", 'export const B = () => <Card.Root><button /></Card.Root>;');
  expect(tsx(composed, 'packages/ui/src/components/b.tsx')).toEqual(['raw-element:2']);
});

test('mux-import reports @muxui/react outside packages/ui/src in scripts and stylesheets', () => {
  const source = lines(
    "import { Button } from '@muxui/react';",
    "export { Card } from '@muxui/react/card';",
    "const lazy = () => import('@muxui/react');",
    "import { other } from '@muxui/reactive';",
    "// import '@muxui/react';",
  );
  expect(found(scanScript('packages/web/src/x.ts', source))).toEqual(['mux-import:1', 'mux-import:2', 'mux-import:3']);
  expect(scanScript('packages/ui/src/x.ts', source)).toEqual([]);
  const sheet = "@import '@muxui/react/styles.css';\n/* @import '@muxui/react'; */";
  expect(css(sheet)).toEqual(['mux-import:1']);
  expect(css(sheet, none, 'packages/ui/src/styles.css')).toEqual([]);
});

test('css-colour reports hex, colour functions and named colours, not tokens or neutral keywords', () => {
  const sheet = lines(
    '.a {', // 1
    '  color: #fff;', // 2
    '  background: rgb(0 0 0 / 0.5);', // 3
    '  border: 1px solid hsl(0 0% 50%);', // 4
    '  outline-color: white;', // 5
    '  --pb-x: #123456;', // 6
    '  color: var(--muxui-primitive-red-500);', // 7
    '  background: transparent;', // 8
    '  border-color: currentColor;', // 9
    '  color: inherit; /* #000 */', // 10
    "  background: url('#red') no-repeat;", // 11
    '}',
  );
  const defined = new Set(['--muxui-primitive-red-500']);
  expect(css(sheet, { aliases: new Set(), defined })).toEqual([
    'css-colour:2',
    'css-colour:3',
    'css-colour:4',
    'css-colour:5',
    'css-colour:6',
  ]);
});

test('radius, shadow and font values must come from Mux tokens or a pure alias', () => {
  const sheet = lines(
    '.a {', // 1
    '  border-radius: var(--muxui-semantic-radius-md);', // 2
    '  border-radius: 4px;', // 3
    '  border-top-left-radius: 50%;', // 4
    '  border-radius: 0;', // 5
    '  box-shadow: var(--muxui-shadow-sm);', // 6
    '  box-shadow: 0 1px 2px var(--muxui-x);', // 7
    '  box-shadow: none;', // 8
    '  font-family: var(--pb-font);', // 9
    '  font-family: var(--pb-other);', // 10
    "  font-family: 'Inter', sans-serif;", // 11
    '  font-size: var(--muxui-font-size-sm);', // 12
    '  font-size: calc(var(--muxui-font-size-sm) * 1.2);', // 13
    '  font-size: 0.9em;', // 14
    '  font-size: inherit;', // 15
    '  font: 14px/1.45 var(--pb-font);', // 16
    '  font: 600 var(--muxui-font-size-sm) monospace;', // 17
    '}',
  );
  expect(css(sheet, { aliases: new Set(['--pb-font']), defined: { has: () => true } })).toEqual([
    'css-radius:3',
    'css-radius:4',
    'css-shadow:7',
    'css-font-family:10',
    'css-font-family:11',
    'css-font-size:14',
    'css-font-size:16',
    'css-font-family:17',
  ]);
});

const anyDefined: CssContext = { aliases: new Set(), defined: { has: () => true } };

test('spacing, weight, line height and letter spacing must be tokens, zero or a neutral keyword', () => {
  const sheet = lines(
    '.a {', // 1
    '  padding: var(--muxui-semantic-layout-inset-small) 0;', // 2
    '  padding: 8px 12px;', // 3
    '  margin: 0 auto;', // 4
    '  margin-inline-start: calc(-1 * var(--muxui-semantic-layout-group-gap));', // 5
    '  gap: calc(var(--muxui-a) + 4px);', // 6
    '  row-gap: normal;', // 7
    '  font-weight: var(--muxui-reference-number-font-weight-semibold);', // 8
    '  font-weight: 600;', // 9
    '  font-weight: bold;', // 10
    '  line-height: 1;', // 11
    '  line-height: normal;', // 12
    '  letter-spacing: 0.2em;', // 13
    '  border-width: 2px;', // 14
    '  max-inline-size: 940px;', // 15
    '}',
  );
  expect(css(sheet, anyDefined)).toEqual([
    'css-spacing:3',
    'css-spacing:6',
    'css-font-weight:9',
    'css-font-weight:10',
    'css-line-height:11',
    'css-letter-spacing:13',
  ]);
});

test('a /* layout */ comment waives a spacing value on its declaration and is counted', () => {
  const sheet = lines(
    '.a {', // 1
    '  margin-inline-start: 46px; /* layout */', // 2
    '  padding-block-start: 1lh /* layout */;', // 3
    '  /* layout */', // 4
    '  padding: 3px;', // 5
    '  font-weight: 700; /* layout */', // 6
    '}',
  );
  const result = scanCss('packages/web/src/a.css', sheet, anyDefined);
  expect(found(result.violations)).toEqual(['css-spacing:5', 'css-font-weight:6']);
  expect(result.layout).toEqual({ comments: 4, used: 2 });
});

test('motion must use Mux duration and easing tokens; infinite animations and !important are reported', () => {
  const sheet = lines(
    '.a {', // 1
    '  transition: opacity var(--muxui-reference-motion-duration-fast) var(--muxui-reference-motion-easing-standard);', // 2
    '  animation: pb-sheet-in 0.22s ease-out;', // 3
    '  transition-duration: 0s;', // 4
    '  transition-timing-function: cubic-bezier(0.2, 0, 0, 1);', // 5
    '  animation: spin var(--muxui-reference-motion-duration-slow) infinite;', // 6
    '  transition: none;', // 7
    '  scroll-behavior: auto !important;', // 8
    '}',
  );
  expect(css(sheet, anyDefined)).toEqual(['css-motion:3', 'css-motion:5', 'css-infinite:6', 'css-important:8']);
});

test('css-unknown-token reports a var() that Mux, tokens.css and the file itself do not define', () => {
  const sheet = lines(
    '.a {', // 1
    '  --local: var(--muxui-semantic-layout-inset-small);', // 2
    '  padding: var(--local);', // 3
    '  color: var(--muxui-semantic-content-danger);', // 4
    '  color: var(--pb-fg);', // 5
    '  color: var(--pb-gone);', // 6
    '}',
  );
  const context = { aliases: new Set(['--pb-fg']), defined: new Set(['--muxui-semantic-layout-inset-small', '--pb-fg']) };
  expect(css(sheet, context)).toEqual(['css-unknown-token:4', 'css-unknown-token:6']);
});

test('a local custom property counts as a token only when it is built from tokens', () => {
  const sheet = lines('.a {', '  --rail: var(--muxui-x);', '  --wide: 13px;', '  padding: var(--rail);', '  padding: var(--wide);', '}');
  expect(css(sheet, anyDefined)).toEqual(['css-spacing:5']);
});

test('css-blur reports blurs; css-element-selector reports styling by tag, not by class, inside Mux parts or in :has()', () => {
  const sheet = lines(
    '.a img { filter: blur(14px); }', // 1
    '.a p, .a h2 { margin: 0; }', // 2
    '.a > div { margin: 0; }', // 3
    '.muxui-sidebar__nav-list a { margin: 0; }', // 4
    '.b:has(input:checked) { margin: 0; }', // 5
    '.c :is(h2, h3) { margin: 0; }', // 6
    '.d svg, .d time { margin: 0; }', // 7
    "[data-muxui-state-selected] a, input[type='file']::file-selector-button { margin: 0; }", // 8
    '@media (width < 40rem) { .e button { margin: 0; } }', // 9
  );
  expect(css(sheet, anyDefined)).toEqual([
    'css-element-selector:1',
    'css-element-selector:2',
    'css-element-selector:6',
    'css-element-selector:8',
    'css-element-selector:9',
    'css-blur:1',
  ]);
});

test('an alias counts as a token only when every definition is purely Mux tokens, one level deep', () => {
  const tokens = lines(
    ':root {',
    '  --pb-fg: var(--muxui-semantic-typography-text-color);',
    '  --pb-font: var(--muxui-a), var(--muxui-b);',
    '  --pb-muted: #595959;',
    '  --pb-line: var(--muxui-c);',
    '  --pb-chain: var(--pb-fg);',
    '  --pb-width: 248px;',
    '}',
    "[data-muxui-color-scheme='dark'] { --pb-line: #2c2c2c; }",
  );
  expect([...pureAliases(tokens)]).toEqual(['--pb-fg', '--pb-font']);
});

test('the Mux token list comes from the vendored tarball', () => {
  const tarball = join(import.meta.dirname, '../vendor/muxui/muxui-react-0.1.0-rc.6.tgz');
  const tokens = muxTokens();
  expect(tokens.size).toBe(1221);
  expect(tokens.has('--muxui-semantic-content-default')).toBe(true);
  expect(tokens.has('--muxui-semantic-content-danger')).toBe(false);
  expect(muxTokens()).toBe(tokens);
  expect(tarFile(readFileSync(tarball), 'package/missing.css')).toBeUndefined();
});

test('an exception hides exactly its count of violations; a stale or too broad one is a problem', () => {
  const v = (detail: string, anchor: string[]): Violation => ({ file: 'a.tsx', line: 1, rule: 'raw-element', detail, anchor });
  const violations = [v('<a> (Link)', ['PostCard']), v('<a> (Link)', ['Other']), v('<img> (Image)', ['PostCard'])];
  const exceptions = parseExceptions(
    JSON.stringify([
      { file: 'a.tsx', rule: 'raw-element', match: '<a>', anchor: 'PostCard', reason: 'decorative' },
      { file: 'a.tsx', rule: 'raw-element', match: '<hr>', reason: 'gone' },
      { file: 'a.tsx', rule: 'raw-element', match: '<', reason: 'too broad' },
    ]),
  );
  const { kept, problems } = applyExceptions(violations, exceptions);
  expect(kept).toEqual([]);
  expect(problems).toEqual([
    'a.tsx raw-element "<hr>" matches 0, expected 1 (stale: remove it)',
    'a.tsx raw-element "<" matches 3, expected 1',
  ]);
  expect(() => parseExceptions('[{ "file": "a.tsx", "rule": "raw-element", "match": "<a>" }]')).toThrow(/reason/);
});

test('report mode fails only where a file and rule rose above the baseline', () => {
  const counts = count([
    { file: 'a.css', line: 1, rule: 'css-colour', detail: '' },
    { file: 'a.css', line: 2, rule: 'css-colour', detail: '' },
    { file: 'b.tsx', line: 1, rule: 'raw-element', detail: '' },
  ]);
  expect(counts).toEqual({ 'a.css': { 'css-colour': 2 }, 'b.tsx': { 'raw-element': 1 } });
  expect(regressions(counts, { 'a.css': { 'css-colour': 2 }, 'b.tsx': { 'raw-element': 3 } })).toEqual([]);
  expect(regressions(counts, { 'a.css': { 'css-colour': 1 } })).toEqual([
    { file: 'a.css', rule: 'css-colour', before: 1, now: 2 },
    { file: 'b.tsx', rule: 'raw-element', before: 0, now: 1 },
  ]);
});

test('areas follow the product: shell, feed, thread and so on, with packages/ui as shared ui', () => {
  expect(area('packages/web/src/shell/sidebar.tsx')).toBe('shell');
  expect(area('packages/web/src/routes/__root.tsx')).toBe('shell');
  expect(area('packages/web/src/routes/-legal/legal.css')).toBe('shell');
  expect(area('packages/web/src/routes/index/-feed/feed.css')).toBe('feed');
  expect(area('packages/web/src/routes/post/$id/comments/-ui/comments.css')).toBe('thread');
  expect(area('packages/web/src/routes/communities/-ui/directory.css')).toBe('community');
  expect(area('packages/web/src/routes/notifications/-ui/inbox.tsx')).toBe('profile');
  expect(area('packages/web/src/routes/submit/-ui/submit.css')).toBe('composer');
  expect(area('packages/ui/src/composer/composer.css')).toBe('composer');
  expect(area('packages/web/src/routes/report/-ui/report.css')).toBe('moderation');
  expect(area('packages/web/src/routes/admin/bans/index.tsx')).toBe('admin');
  expect(area('packages/ui/src/components/post-card.css')).toBe('shared ui');
});
