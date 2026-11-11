import { readFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import { expect, test } from 'vitest';
import {
  applyExceptions,
  area,
  count,
  cssGlob,
  muxTarball,
  muxTokens,
  parseExceptions,
  pureAliases,
  regressions,
  scanCss,
  scanScript,
  scriptGlob,
  tarFile,
  type CssContext,
  vendoredTarball,
  type Violation,
  walked,
} from './mux-guard.ts';

const found = (violations: { rule: string; line: number }[]) => violations.map(({ rule, line }) => `${rule}:${line}`);
const lines = (...source: string[]) => source.join('\n');
const tsx = (source: string, file = 'packages/web/src/routes/a.tsx') => found(scanScript(file, source));
const none: CssContext = { aliases: new Set(), defined: new Set(), mux: new Set() };
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
    "    <div style={{ '--muxui-my-gap': 'var(--muxui-semantic-layout-group-gap)' }} />", // 13
    "    <div style={{ padding: 'var(--muxui-my-gap)' }} />", // 14
    "    <div style={{ '--muxui-semantic-layout-group-gap': 'var(--muxui-semantic-layout-tight-gap)' }} />", // 15
    '  </>', // 16
    ');', // 17
  );
  expect(tsx(source)).toEqual([
    'inline-style:5',
    'inline-style:6',
    'inline-style:7',
    'inline-style:8',
    'inline-style:10',
    'inline-style:11',
    'inline-style:13',
    'inline-style:14',
  ]);
});

test('an inline style sets a Mux token only to a written var() of a Mux token, whatever kind of expression the value is', () => {
  const source = lines(
    "const tint = '#f00';", // 1
    'export const A = () => (', // 2
    '  <>', // 3
    "    <div style={{ '--muxui-semantic-content-default': tint }} />", // 4
    "    <div style={{ '--muxui-semantic-content-default': `var(--muxui-semantic-${tone})` }} />", // 5
    "    <div style={{ '--muxui-semantic-typography-control-weight': 900 }} />", // 6
    "    <div style={{ '--pb-x': `var(--muxui-made-up) ${x}` }} />", // 7
    "    <div style={{ '--muxui-semantic-layout-group-gap': 'var(--muxui-semantic-layout-tight-gap)' }} />", // 8: legal
    "    <div style={{ '--depth': depth, '--pb-tint': tint }} />", // 9: data and other custom properties, legal
    '  </>', // 10
    ');', // 11
  );
  expect(tsx(source)).toEqual(['inline-style:4', 'inline-style:5', 'inline-style:6', 'inline-style:7']);
});

test('a spread of an object literal counts as its props, in order; a spread of a variable stays allowed', () => {
  const source = lines(
    'export const A = (rest: Props) => (', // 1
    '  <>', // 2
    '    <input type="hidden" {...{ type: \'text\' }} />', // 3
    "    <div {...{ role: 'button', style: { color: '#f00' } }} />", // 4
    '    <span {...{ ...{ onClick: go } }} />', // 5
    '    <input type="hidden" {...rest} />', // 6: rest may set the type
    '    <input {...{ type: \'text\' }} type="hidden" name="id" />', // 7: legal, the later type wins
    '    <div {...rest} className="pb-row" />', // 8: legal, rest props pass through
    '  </>', // 9
    ');', // 10
  );
  expect(tsx(source)).toEqual(['raw-element:3', 'inline-style:4', 'widget-role:4', 'widget-handler:5', 'raw-element:6']);
});

test('React factories, however imported or renamed, get the element rules over their props', () => {
  const source = lines(
    "import { createElement as h } from 'react';", // 1
    "import * as R from 'react';", // 2
    "import { jsx } from 'react/jsx-runtime';", // 3
    "createElement('div', { role: 'button', style: { color: '#f00' } });", // 4
    "h('button', null, 'go');", // 5
    "h('a', { href: '/x' });", // 6
    "R.createElement('span', { onClick: go }, 'text');", // 7
    "jsx('div', { children: 'words' });", // 8
    'const make = R.createElement;', // 9
    "make('table');", // 10
    "h(Card, { style: { padding: '13px' } });", // 11
    "h('div', { className: 'pb-row' }, h(Text, null, 'ok'));", // 12: legal
    "document.createElement('div').setAttribute('data-x', '1');", // 13: legal, not React
  );
  expect(tsx(source)).toEqual([
    'inline-style:4',
    'widget-role:4',
    'raw-element:5',
    'raw-element:6',
    'widget-handler:7',
    'bare-text:7',
    'bare-text:8',
    'raw-element:10',
    'inline-style:11',
  ]);
});

test('CSS written inside a script is reported: <style> elements, CSSOM calls and writes to an element style', () => {
  const source = lines(
    "import modCss from './mod.css?inline';", // 1
    'export const A = () => (', // 2
    '  <>', // 3
    "    <style>{'.x { color: #f00; padding: 13px !important; }'}</style>", // 4
    '    <style>{`.x { color: #f00; }`}</style>', // 5
    '    <style dangerouslySetInnerHTML={{ __html: modCss }} />', // 6
    "    <div style={{ cssText: 'color: #f00' }} />", // 7
    '    <style href="mod-panels" precedence="mod-panels">', // 8: legal, a stylesheet file the guard reads
    '      {modCss}', // 9
    '    </style>', // 10
    '  </>', // 11
    ');', // 12
    "createElement('style', null, '.x { color: #f00; }');", // 13
    "document.head.append(document.createElement('style'));", // 14
    "sheet.insertRule('.x { color: #f00; }');", // 15
    "sheet.replaceSync('.x { color: #f00; }');", // 16
    'document.adoptedStyleSheets = [sheet];', // 17
    "el.style.cssText = 'color: #f00';", // 18
    "el.style.setProperty('--muxui-semantic-content-default', '#f00');", // 19
    "el.style.color = '#f00';", // 20
    "el['style'] = 'color: #f00';", // 21
    "el.setAttribute('style', 'color: #f00');", // 22
    "Object.assign(el.style, { color: '#f00' });", // 23
    'const width = el.style.width;', // 24: legal, a read
  );
  expect(tsx(source)).toEqual([
    'raw-element:4',
    'raw-element:5',
    'raw-element:6',
    'inline-style:7',
    'raw-element:13',
    'raw-element:14',
    'inline-style:15',
    'inline-style:16',
    'inline-style:17',
    'inline-style:18',
    'inline-style:19',
    'inline-style:20',
    'inline-style:21',
    'inline-style:22',
    'inline-style:23',
  ]);
});

test('a <style> may hold the ?inline stylesheet only through its import, not a parameter, local or prop of that name', () => {
  const source = lines(
    "import modCss from './mod.css?inline';", // 1
    'export function ModStyles({ modCss = defaultCss }) {', // 2
    '  return <style>{modCss}</style>;', // 3: a caller supplies the CSS
    '}', // 4
    'export const B = ({ css: modCss }) => <style>{modCss}</style>;', // 5
    'export function C(modCss) { return <style>{modCss}</style>; }', // 6
    "export const D = () => { const modCss = '.x { color: #f00; }'; return <style>{modCss}</style>; };", // 7
    'export function E() { try { go(); } catch (modCss) { return <style>{modCss}</style>; } }', // 8
    "export const F = function modCss() { return createElement('style', null, modCss); };", // 9
    'export const G = () => <style>{modCss}</style>;', // 10: legal, the import
    'export function H({ css }) { const other = css; return <style href="h" precedence="h">{modCss}</style>; }', // 11: legal
    "export const I = () => { { const modCss = 'x'; } return <style>{modCss}</style>; };", // 12: legal, that modCss ends with its block
    'export const J = () => { if (go) { var modCss = hand; } return <style>{modCss}</style>; };', // 13: a var is the function's
  );
  expect(tsx(source)).toEqual([
    'raw-element:3',
    'raw-element:5',
    'raw-element:6',
    'raw-element:7',
    'raw-element:8',
    'raw-element:9',
    'raw-element:13',
  ]);
});

test("a <style>'s content is its effective child: the children prop or the JSX children, comments and whitespace aside", () => {
  const source = lines(
    "import modCss from './mod.css?inline';", // 1
    'export const A = () => (', // 2
    '  <>', // 3
    '    <style children={modCss} />', // 4: legal
    '    <style href="a" precedence="a">', // 5: legal
    "      {/* the moderation panels' stylesheet */}", // 6
    '      {modCss}', // 7
    '    </style>', // 8
    '    <style> {modCss} </style>', // 9: legal
    "    <style children={modCss}>{'.x { color: #f00; }'}</style>", // 10: the JSX children win
    "    <style children={'.x { color: #f00; }'}>{/* none */}</style>", // 11
    '    <style {...rest}>{modCss}</style>', // 12: the spread may set any prop, dangerouslySetInnerHTML too
    '    <style {...{ children: modCss }} />', // 13: legal
    '  </>', // 14
    ');', // 15
    "createElement('style', { children: modCss });", // 16: legal
    "createElement('style', { children: modCss }, '.x { color: #f00; }');", // 17: the arguments win
    'export const B = ({ modCss }) => <style children={modCss} />;', // 18: a prop, not the import
  );
  expect(tsx(source)).toEqual(['raw-element:10', 'raw-element:11', 'raw-element:12', 'raw-element:17', 'raw-element:18']);
});

test('the forms beside those holes: string and spread styles, tag variables, as props, typed OM and stylesheet links', () => {
  const source = lines(
    "const Tag = level ? 'h2' : 'button';", // 1
    'export const A = () => (', // 2
    '  <>', // 3
    '    <div style="color: #f00" />', // 4
    "    <div style={{ ...{ color: '#f00' } }} />", // 5
    "    <div style={{ WebkitBoxShadow: '0 1px 2px #000' }} />", // 6
    '    <Tag onClick={go} />', // 7
    '    <Text as="button" onClick={go}>go</Text>', // 8
    '    <link rel="stylesheet" href="https://example.com/theme.css" />', // 9
    '    <Text as="h2" className={`pb-title ${size}`}>ok</Text>', // 10: legal
    '    <link rel="stylesheet" href={appCss} />', // 11: legal, an imported file
    '  </>', // 12
    ');', // 13
    "el.attributeStyleMap.set('color', '#f00');", // 14
    "export const head = () => ({ links: [{ rel: 'stylesheet', href: '/theme.css' }, { rel: 'stylesheet', href: appCss }] });", // 15
  );
  expect(tsx(source)).toEqual([
    'inline-style:4',
    'inline-style:5',
    'inline-style:6',
    'text-element:7',
    'raw-element:7',
    'raw-element:8',
    'css-import:9',
    'inline-style:14',
    'css-import:15',
  ]);
  expect(
    css('.a { -webkit-box-shadow: 0 1px 2px var(--muxui-x); -webkit-border-radius: 4px; -webkit-line-clamp: 2; }', anyDefined),
  ).toEqual(['css-shadow:1', 'css-radius:1']);
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

test('every source file of every package and tool is checked, whatever its extension or folder', () => {
  const button = 'export const A = () => <button>go</button>;';
  expect(tsx(button, 'packages/web/app/a.jsx')).toEqual(['raw-element:1']);
  expect(tsx(button, 'packages/ui/stories/a.tsx')).toEqual(['raw-element:1']);
  expect(tsx(button, 'packages/core/src/mail/a.tsx')).toEqual(['raw-element:1']);
  expect(tsx("import { createElement as h } from 'react';\nh('button');", 'packages/web/src/a.mts')).toEqual(['raw-element:2']);
  expect(tsx(button, 'packages/web/src/a.test.tsx')).toEqual(['raw-element:1']); // scanScript itself does not skip tests; the walk does
});

test('the walk takes every extension the build can import and skips only tests, fixtures, generated files and output', () => {
  for (const file of ['packages/web/src/a.mts', 'packages/web/src/a.cjs', 'packages/web/app/a.jsx', 'tools/x/a.mjs', 'packages/ui/a.css'])
    expect([file, matchesGlob(file, file.endsWith('.css') ? cssGlob : scriptGlob) && walked(file)]).toEqual([file, true]);
  for (const file of [
    'packages/web/src/a.test.mts',
    'packages/web/src/__fixtures__/a.tsx',
    'packages/web/src/routeTree.gen.ts',
    'packages/web/dist/a.js',
    'packages/web/.output/a.mjs',
    'packages/ui/node_modules/x/a.css',
    'e2e/a.ts',
  ])
    expect([file, walked(file)]).toEqual([file, false]);
});

test("Mux's stylesheet holds only @import and @layer; no stylesheet may be imported from outside the walk", () => {
  const mux = lines(
    '@layer reset, muxui.tokens, muxui.components, muxui.utilities, app; /* order */', // 1
    "@import '@muxui/react/styles.css';", // 2
    '.x { color: #f00 !important; }', // 3
  );
  expect(css(mux, anyDefined, 'packages/ui/src/styles.css')).toEqual([
    'css-mux-stylesheet:3',
    'css-mux-stylesheet:3',
    'css-colour:3',
    'css-important:3',
  ]);
  const sheet = lines(
    "@import '@peblish/ui/tokens/tokens.css';", // 1: legal
    "@import './shell/shell.css';", // 2: legal
    "@import url('../../../../vendor/theme.css');", // 3
    "@import 'some-library/dist/theme.css' layer(app);", // 4
    "@import '@muxui/react/styles.css';", // 5: mux-import, not both
  );
  expect(css(sheet, anyDefined)).toEqual(['css-import:3', 'css-import:4', 'mux-import:5']);
  const script = lines(
    "import appCss from '../styles.css?url';", // 1: legal
    "import '@peblish/ui/composer/composer.css';", // 2: legal
    "import 'some-library/dist/theme.css';", // 3
    "import muxCss from '@muxui/react/styles.css?inline';", // 4: Mux's stylesheet outside styles.css
  );
  expect(found(scanScript('packages/ui/src/a.ts', script))).toEqual(['css-import:3', 'css-import:4']);
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
  expect(css(sheet, { aliases: new Set(), defined, mux: defined })).toEqual([
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
  expect(
    css(sheet, { aliases: new Set(['--pb-font']), defined: { has: () => true }, mux: { has: (name) => name.startsWith('--muxui-') } }),
  ).toEqual([
    'css-radius:3',
    'css-radius:4',
    'css-shadow:7',
    'css-font-family:10',
    'css-font-family:11',
    'css-font-size:14',
    'css-font-size:16',
    'css-line-height:16',
    'css-font-family:17',
    'css-font-weight:17',
  ]);
});

const anyMux = { has: (name: string) => name.startsWith('--muxui-') };
const anyDefined: CssContext = { aliases: new Set(), defined: { has: () => true }, mux: anyMux };

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

test('a var() fallback is checked as the value it stands in for; a font shorthand writes no weight or line height', () => {
  const sheet = lines(
    '.a {', // 1
    '  gap: var(--muxui-semantic-layout-group-gap, 13px);', // 2
    '  padding: var(--muxui-a, var(--muxui-b, 4px)) 0;', // 3
    '  margin: var(--muxui-a, calc(2px + 1px));', // 4
    '  transition: opacity var(--muxui-d, 200ms);', // 5
    '  font: 700 var(--muxui-size)/1.7 var(--muxui-family);', // 6
    '  font: var(--muxui-weight, bold) var(--muxui-size) var(--muxui-family);', // 7
    '  font: italic var(--muxui-weight) var(--muxui-size)/var(--muxui-leading) var(--muxui-family);', // 8: legal
    '  gap: var(--muxui-a, var(--muxui-b));', // 9: legal
    '  font: calc(var(--muxui-size) * 1.2) / normal var(--muxui-family);', // 10: legal
    '}',
  );
  expect(css(sheet, anyDefined)).toEqual([
    'css-spacing:2',
    'css-spacing:3',
    'css-spacing:4',
    'css-motion:5',
    'css-font-weight:6',
    'css-line-height:6',
    'css-font-weight:7',
  ]);
});

test('a font shorthand in a var() fallback is checked as a font shorthand, on each branch of its fallbacks', () => {
  const size = 'var(--muxui-semantic-typography-text-s-font-size)';
  const family = 'var(--muxui-semantic-typography-text-font-family)';
  const sheet = lines(
    '.a {', // 1
    `  --body-font: ${size} ${family};`, // 2
    `  font: var(--body-font, 700 ${size} / 1.7 ${family});`, // 3
    `  font: var(--body-font, var(--muxui-weight, bold) ${size} ${family});`, // 4
    `  font: var(--muxui-a, ${size} / 1.7) var(--muxui-b, 700) ${family};`, // 5: 700 is a weight when --muxui-a is set
    `  font: var(--body-font, var(--muxui-weight) ${size} / var(--muxui-leading) ${family});`, // 6: legal
    `  font: var(--body-font, italic ${size} / normal ${family});`, // 7: legal
    '}', // 8
  );
  expect(css(sheet, anyDefined)).toEqual([
    'css-font-weight:3',
    'css-line-height:3',
    'css-font-weight:4',
    'css-font-weight:5',
    'css-line-height:5',
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
  const context = {
    aliases: new Set(['--pb-fg']),
    defined: new Set(['--muxui-semantic-layout-inset-small', '--pb-fg']),
    mux: new Set(['--muxui-semantic-layout-inset-small']),
  };
  expect(css(sheet, context)).toEqual(['css-unknown-token:4', 'css-unknown-token:6']);
});

test('a local custom property counts as a token only when it is built from tokens', () => {
  const sheet = lines('.a {', '  --rail: var(--muxui-x);', '  --wide: 13px;', '  padding: var(--rail);', '  padding: var(--wide);', '}');
  expect(css(sheet, anyDefined)).toEqual(['css-spacing:5']);
});

// Mux's real tokens, apart from tokens.css's aliases: what a stylesheet may set and to what.
const themed: CssContext = {
  aliases: new Set(['--pb-gap', '--pb-inset']),
  defined: new Set([
    '--muxui-semantic-layout-group-gap',
    '--muxui-semantic-layout-tight-gap',
    '--muxui-component-button-radius',
    '--pb-gap',
    '--pb-inset',
  ]),
  mux: new Set(['--muxui-semantic-layout-group-gap', '--muxui-semantic-layout-tight-gap', '--muxui-component-button-radius']),
};

test('a --muxui-* name Mux UI does not define is unknown where it is set and where it is read, even in one file', () => {
  const sheet = lines(
    '.x {', // 1
    '  --muxui-my-gap: 13px;', // 2
    '  gap: var(--muxui-my-gap);', // 3
    '  --muxui-my-rail: var(--muxui-semantic-layout-group-gap);', // 4
    '  padding: var(--muxui-my-rail);', // 5
    '}',
  );
  expect(css(sheet, themed)).toEqual(['css-unknown-token:2', 'css-unknown-token:3', 'css-unknown-token:4', 'css-unknown-token:5']);
});

test('a real Mux token or tokens.css alias may be set to tokens (theming) but not to a literal value', () => {
  const sheet = lines(
    '.x {', // 1
    '  --muxui-semantic-layout-group-gap: var(--muxui-semantic-layout-tight-gap);', // 2: theming, legal
    '  --muxui-component-button-radius: 0;', // 3: zero, legal
    '  --muxui-semantic-layout-tight-gap: calc(2 * var(--pb-inset));', // 4: maths over tokens, legal
    '  --muxui-semantic-layout-group-gap: 13px;', // 5
    '  --muxui-component-button-radius: 600;', // 6
    '  --muxui-semantic-layout-tight-gap: calc(var(--muxui-semantic-layout-group-gap) + 3px);', // 7
    '  --pb-gap: 1rem;', // 8
    '  gap: var(--pb-gap);', // 9: no longer an alias in this file, so 1rem is hand-written
    '}',
  );
  expect(css(sheet, themed)).toEqual(['css-token-value:5', 'css-token-value:6', 'css-token-value:7', 'css-token-value:8', 'css-spacing:9']);
});

test("@property may not register a --muxui-* name; another registration's initial-value is checked as its definition", () => {
  const sheet = lines(
    "@property --muxui-semantic-layout-group-gap { syntax: '<length>'; inherits: true; initial-value: 13px; }", // 1
    "@property --muxui-my-gap { syntax: '*'; inherits: false; }", // 2
    "@property --pb-gap { syntax: '<length>'; inherits: true; initial-value: 1rem; }", // 3
    "@property --wide { syntax: '<length>'; inherits: false; initial-value: 13px; }", // 4
    '.x { padding: var(--wide); }', // 5
    "@property --angle { syntax: '<angle>'; inherits: false; initial-value: 0deg; }", // 6: legal
    '.y { rotate: var(--angle); }', // 7: legal
  );
  expect(css(sheet, themed)).toEqual(['css-token-value:1', 'css-unknown-token:2', 'css-token-value:3', 'css-spacing:5']);
});

test('CSS escapes are decoded outside strings before any check; in selectors and strings they stay allowed', () => {
  const sheet = lines(
    '.a { color: r\\67 b(255 0 0); }', // 1
    '.b { margin: 0 !impor\\74 ant; }', // 2
    '.c { p\\61 dding: 13px; }', // 3
    '.d { --muxui-\\73 emantic-layout-group-gap: 13px; }', // 4
    '.e \\62 utton { margin: 0; }', // 5
    "@property --muxui-\\73 emantic-layout-group-gap { syntax: '*'; inherits: true; }", // 6
    ".f::before { content: '\\201C'; }", // 7: legal, an escape in a string
    '.w-1\\/2, .g\\:hover { margin: 0; }', // 8: legal, escapes in class names
  );
  expect(css(sheet, themed)).toEqual([
    'css-element-selector:5',
    'css-token-value:6',
    'css-colour:1',
    'css-important:2',
    'css-spacing:3',
    'css-token-value:4',
  ]);
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

test('an element is inside Mux markup only as a descendant or child of a .muxui-* compound, on every branch', () => {
  const sheet = lines(
    '.muxui-link + a { margin: 0; }', // 1
    '.muxui-link ~ p { margin: 0; }', // 2
    ':is(.plain, .muxui-link) a { margin: 0; }', // 3
    ':where(.muxui-card, .plain) > button { margin: 0; }', // 4
    '.muxui-card :is(.plain, .x + a) { margin: 0; }', // 5: legal, both branches are inside the card
    '.muxui-card > :where(a, .x) { margin: 0; }', // 6: legal
    '.muxui-list li + li a { margin: 0; }', // 7: legal, the siblings are inside the list
    '.muxui-tabs a:nth-child(2n + 1) { margin: 0; }', // 8: legal
    'a.muxui-link { margin: 0; }', // 9: legal, Mux renders this anchor itself
  );
  expect(css(sheet, anyDefined)).toEqual([
    'css-element-selector:1',
    'css-element-selector:2',
    'css-element-selector:3',
    'css-element-selector:4',
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

test("the vendored tarball is the one packages/ui's file: dependency names", () => {
  const dependency = (spec: string) => JSON.stringify({ dependencies: { '@muxui/react': spec } });
  expect(vendoredTarball(dependency('file:../../vendor/muxui/muxui-react-9.tgz'))).toBe(
    join(import.meta.dirname, '../vendor/muxui/muxui-react-9.tgz'),
  );
  expect(() => vendoredTarball(dependency('0.1.0'))).toThrow(/file: tarball/);
  expect(readFileSync(muxTarball).length).toBeGreaterThan(0);
});

test('the Mux token list comes from the vendored tarball', () => {
  const tarball = muxTarball;
  const tokens = muxTokens();
  expect(tokens.size).toBe(1220);
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

test('a selector exception holds for every branch of the list; a declaration exception can name its value and at-rule', () => {
  const file = 'packages/ui/src/a.css';
  const sheet = lines(
    '.pb-prose a, button { margin: 0; }', // 1: a global button rule rides on the prose exception
    '.pb-prose td, .pb-prose th { margin: 0; }', // 2: legal
    '@media (prefers-reduced-motion: reduce) { * { scroll-behavior: smooth !important; } }', // 3
    '* { scroll-behavior: auto !important; }', // 4: outside the media query
    '@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }', // 5: legal
  );
  const exceptions = parseExceptions(
    JSON.stringify([
      { file, rule: 'css-element-selector', match: '.pb-prose ', count: 2, reason: 'prose' },
      {
        file,
        rule: 'css-important',
        match: 'scroll-behavior',
        anchor: '*',
        value: 'auto',
        condition: '@media (prefers-reduced-motion: reduce)',
        reason: 'reduced motion',
      },
    ]),
  );
  const { kept, problems } = applyExceptions(scanCss(file, sheet, anyDefined).violations, exceptions);
  expect(found(kept)).toEqual(['css-element-selector:1', 'css-important:3', 'css-important:4']);
  expect(problems).toEqual([`${file} css-element-selector ".pb-prose " matches 1, expected 2`]);
  expect(() => parseExceptions(JSON.stringify([{ file, rule: 'css-important', match: 'x', condition: 'media', reason: 'r' }]))).toThrow(
    /condition/,
  );
});

test('a selector exception must match every branch that styles an element, after :is(), :where() and nesting are expanded', () => {
  const file = 'packages/ui/src/a.css';
  const sheet = lines(
    '.pb-prose blockquote, .pb-quote { margin: 0; }', // 1: legal, .pb-quote styles no element
    ':is(.pb-prose a, button) { margin: 0; }', // 2: every button rides on the prose exception
    '.pb-prose :is(td, th), .pb-quote { margin: 0; }', // 3: legal
    ':where(.pb-prose, .x) pre { margin: 0; }', // 4: a pre under .x
    '.pb-prose a {', // 5: legal
    '  &:hover, .pb-quote & { margin: 0; }', // 6: legal, no element of its own
    '  & code, > b { margin: 0; }', // 7: legal, inside .pb-prose a
    '}', // 8
    '.pb-prose, .x { & button { margin: 0; } }', // 9: a button under .x
    '.muxui-card { a { margin: 0; } & + a { margin: 0; } }', // 10: the nested a is inside the card, its sibling is not
  );
  const exceptions = parseExceptions(
    JSON.stringify([{ file, rule: 'css-element-selector', match: '.pb-prose ', count: 4, reason: 'prose' }]),
  );
  const { kept, problems } = applyExceptions(scanCss(file, sheet, anyDefined).violations, exceptions);
  expect(found(kept)).toEqual(['css-element-selector:2', 'css-element-selector:4', 'css-element-selector:9', 'css-element-selector:10']);
  expect(problems).toEqual([]);
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
