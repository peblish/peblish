import { expect, test } from 'vitest';
import { area, count, pureAliases, regressions, scanCss, scanScript } from './mux-guard.ts';

const found = (violations: { rule: string; line: number }[]) => violations.map(({ rule, line }) => `${rule}:${line}`);

test('raw-element reports raw controls in JSX, not in strings, comments or components', () => {
  const tsx = [
    "const label = '<button>';", // 1
    'export const A = () => (', // 2
    '  <div>', // 3
    '    {/* <input> */}', // 4
    '    <button type="button">go</button>', // 5
    '    <Button>ok</Button>', // 6
    '    <input name="q" />', // 7
    '    <table><thead><tr><th>x</th></tr></thead></table>', // 8
    '    <details><summary>more</summary><hr /></details>', // 9
    '  </div>', // 10
    ');', // 11
  ].join('\n');
  expect(found(scanScript('packages/web/src/routes/a.tsx', tsx))).toEqual([
    'raw-element:5',
    'raw-element:7',
    ...Array(4).fill('raw-element:8'),
    ...Array(3).fill('raw-element:9'),
  ]);
});

test('a facade wrapper, which imports @muxui/react, may use raw elements', () => {
  const tsx = "import { Button } from '@muxui/react';\nexport const B = () => <button />;";
  expect(scanScript('packages/ui/src/components/b.tsx', tsx)).toEqual([]);
});

test('mux-import reports @muxui/react outside packages/ui/src in scripts and stylesheets', () => {
  const ts = [
    "import { Button } from '@muxui/react';",
    "export { Card } from '@muxui/react/card';",
    "const lazy = () => import('@muxui/react');",
    "import { other } from '@muxui/reactive';",
    "// import '@muxui/react';",
  ].join('\n');
  expect(found(scanScript('packages/web/src/x.ts', ts))).toEqual(['mux-import:1', 'mux-import:2', 'mux-import:3']);
  expect(scanScript('packages/ui/src/x.ts', ts)).toEqual([]);
  const css = "@import '@muxui/react/styles.css';\n/* @import '@muxui/react'; */";
  expect(found(scanCss('packages/web/src/x.css', css, new Set()))).toEqual(['mux-import:1']);
  expect(scanCss('packages/ui/src/styles.css', css, new Set())).toEqual([]);
});

test('css-colour reports hex, colour functions and named colours, not tokens or neutral keywords', () => {
  const css = [
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
  ].join('\n');
  expect(found(scanCss('packages/web/src/a.css', css, new Set()))).toEqual([
    'css-colour:2',
    'css-colour:3',
    'css-colour:4',
    'css-colour:5',
    'css-colour:6',
  ]);
});

test('radius, shadow and font values must come from Mux tokens or a pure alias', () => {
  const aliases = new Set(['--pb-font']);
  const css = [
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
  ].join('\n');
  expect(found(scanCss('packages/web/src/a.css', css, aliases))).toEqual([
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

test('an alias counts as a token only when every definition is purely Mux tokens, one level deep', () => {
  const tokens = [
    ':root {',
    '  --pb-fg: var(--muxui-semantic-typography-text-color);',
    '  --pb-font: var(--muxui-a), var(--muxui-b);',
    '  --pb-muted: #595959;',
    '  --pb-line: var(--muxui-c);',
    '  --pb-chain: var(--pb-fg);',
    '  --pb-width: 248px;',
    '}',
    "[data-muxui-color-scheme='dark'] { --pb-line: #2c2c2c; }",
  ].join('\n');
  expect([...pureAliases(tokens)]).toEqual(['--pb-fg', '--pb-font']);
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

test('areas group the shell, each route folder and each ui folder', () => {
  expect(area('packages/web/src/shell/sidebar.tsx')).toBe('web/shell');
  expect(area('packages/web/src/routes/admin/bans/index.tsx')).toBe('web/routes/admin');
  expect(area('packages/web/src/routes/__root.tsx')).toBe('web/routes');
  expect(area('packages/ui/src/components/post-card.css')).toBe('ui/components');
  expect(area('packages/ui/src/locale.tsx')).toBe('ui');
});
