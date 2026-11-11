import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { build, type Plugin, type Rolldown } from 'vite';
import { splitDeclarations, splitMuxDeclarations, splitMuxSubstrate } from '../vite.config.ts';

// The client build's split of Mux UI's overlays.js by declaration (vite.config.ts), on the
// vendored package. Two entries, as two routes would be: one with the Tooltip alone (what the
// Sidebar needs on every page), one with the drop zone and the toasts. The Tooltip entry must not
// load React Aria's DropZone or Toast; with substrate.js split alone (the control) it does.
const dir = mkdtempSync(join(tmpdir(), 'peblish-mux-overlays-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, 'tooltip.js'), "import { Tooltip } from '@muxui/react';\nglobalThis.tooltip = Tooltip;\n");
writeFileSync(
  join(dir, 'drop.js'),
  "import { DropZone, Tooltip, ToastProvider, useToast } from '@muxui/react';\nglobalThis.drop = [DropZone, Tooltip, ToastProvider, useToast];\n",
);
const mux = join(import.meta.dirname, '../../ui/node_modules/@muxui/react/generated/index.mjs');

/** Every module the Tooltip entry loads through its static imports. */
async function tooltipEntryModules(plugins: Plugin[]) {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    root: dir,
    resolve: { alias: { '@muxui/react': mux } },
    plugins,
    build: {
      write: false,
      minify: false,
      rolldownOptions: { input: { tooltip: join(dir, 'tooltip.js'), drop: join(dir, 'drop.js') }, external: [/^react(-dom)?(\/|$)/] },
    },
  });
  const chunks = (Array.isArray(result) ? result : [result]).flatMap((output) =>
    'output' in output ? output.output.filter((item): item is Rolldown.OutputChunk => item.type === 'chunk') : [],
  );
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const loaded = new Set<Rolldown.OutputChunk>();
  const visit = (chunk: Rolldown.OutputChunk | undefined) => {
    if (!chunk || loaded.has(chunk)) return;
    loaded.add(chunk);
    for (const file of chunk.imports) visit(byName.get(file));
  };
  visit(chunks.find((chunk) => chunk.isEntry && chunk.name === 'tooltip'));
  expect(loaded.size, 'the Tooltip entry was built').toBeGreaterThan(0);
  return [...loaded].flatMap((chunk) => chunk.moduleIds);
}

const reactAria = (name: string) => (id: string) =>
  new RegExp(`[\\\\/]react-aria-components[\\\\/]dist[\\\\/]private[\\\\/]${name}\\.mjs$`).test(id);

test('a Tooltip-only entry loads no drop zone or toast code once overlays.js is split', { timeout: 90_000 }, async () => {
  // The real plugins as vite.config.ts orders them (the declaration split applies the substrate split to its parts).
  const [whole, split] = [
    await tooltipEntryModules([splitMuxSubstrate()]),
    await tooltipEntryModules([splitMuxSubstrate(), splitMuxDeclarations()]),
  ];
  for (const name of ['DropZone', 'Toast'])
    expect(whole.some(reactAria(name)), `the control: one overlays.js module drags ${name} along`).toBe(true);
  expect(split.some(reactAria('DropZone'))).toBe(false);
  expect(split.some(reactAria('Toast'))).toBe(false);
  expect(split.some(reactAria('Tooltip')), 'the Tooltip itself still loads').toBe(true);
  expect(split.some((id) => id.endsWith('overlays.js?mux-declaration=Tooltip'))).toBe(true);
});

// Synthetic drift: a future overlays.js, built through the declaration split alone. The client
// keeps only what an import reaches, so a top-level initialiser that does something must fail the
// build rather than run on the server and silently vanish from the client.
async function buildOverlays(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'peblish-mux-drift-'));
  try {
    const generated = join(root, 'node_modules/@muxui/react/generated');
    mkdirSync(generated, { recursive: true });
    writeFileSync(join(generated, 'overlays.js'), source);
    writeFileSync(
      join(root, 'entry.js'),
      `import { Tooltip } from ${JSON.stringify(join(generated, 'overlays.js'))};\nglobalThis.tooltip = Tooltip;\n`,
    );
    const result = await build({
      configFile: false,
      logLevel: 'silent',
      root,
      plugins: [splitMuxDeclarations()],
      build: {
        write: false,
        minify: false,
        rolldownOptions: { input: join(root, 'entry.js'), external: [/^react(-dom)?(\/|$)/, /registry/] },
      },
    });
    return (Array.isArray(result) ? result : [result])
      .flatMap((output) => ('output' in output ? output.output : []))
      .flatMap((item) => (item.type === 'chunk' ? [item.code] : []))
      .join('\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const tooltip = "import * as React from 'react';\nexport const Tooltip = React.forwardRef(function Tooltip() { return null; });\n";

test.each([
  ['an unread call', "import { registerOverlay } from './registry.js';\nconst registration = registerOverlay(Tooltip);\n"],
  ['an unread construction', "import { Registry } from './registry.js';\nconst registry = new Registry();\n"],
  ['a tagged template', "import { css } from './registry.js';\nconst styles = css`color: red`;\n"],
  ['a property set to a call', "import { registerOverlay } from './registry.js';\nTooltip.registration = registerOverlay(Tooltip);\n"],
  ['an exported call', "import { registerOverlay } from './registry.js';\nexport const registration = registerOverlay(Tooltip);\n"],
  [
    'a pure-marked call with an effect in its arguments',
    "import { make, registerOverlay } from './registry.js';\nconst made = /*#__PURE__*/ make(registerOverlay(Tooltip));\n",
  ],
  [
    'a getter run by an unread member read',
    "import { registerOverlay } from './registry.js';\nconst unused = ({ get value() { registerOverlay(); return 0; } }).value;\n",
  ],
  [
    'a property set whose computed key runs code',
    "import { registerOverlay } from './registry.js';\nconst unused = {};\nunused[registerOverlay()] = true;\n",
  ],
])('the build fails on a top-level initialiser that may have effects: %s', { timeout: 30_000 }, async (_, drift) => {
  await expect(buildOverlays(tooltip + drift)).rejects.toThrow(/peblish:split-mux-declarations: .*may have effects/);
});

test('pure initialisers pass, and one nothing reads is left out', { timeout: 30_000 }, async () => {
  const code = await buildOverlays(
    tooltip +
      [
        "const GEOMETRY = Object.freeze({ placement: 'top', offset: -8, flip: !false });",
        "const PLACEMENTS = new Set(['top', 'bottom']);",
        'const Context = React.createContext(null);',
        "const useLayout = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;",
        'const UNREAD_MARKER = /*#__PURE__*/ (() => `unread ${GEOMETRY.placement}`)();',
        'const Panel = class extends Object { static label = PLACEMENTS; };',
        "Tooltip.displayName = 'Tooltip';",
      ].join('\n'),
  );
  expect(code).toMatch(/displayName = ["']Tooltip["']/);
  expect(code).not.toContain('unread');
});

// The same check without a build: each value runs code when the module loads, often through an implicit call (a
// getter, an iterator, a conversion), so the split must refuse it.
const registry = "import * as registry from './registry.js';\nimport { registerOverlay, Base, items } from './registry.js';\n";
const getter = 'const box = { get value() { registerOverlay(); return 0; } };\n';
const converts = 'const box = { toString() { registerOverlay(); return "box"; } };\n';
const declarations = (body: string) => () => splitDeclarations('/mux/generated/overlays.js', tooltip + registry + body);

test.each([
  ['a getter on a binding', getter + 'const unused = box.value;\n'],
  ['a getter in an object literal reached through a binding', getter + 'const unused = { box }.box.value;\n'],
  ['a member read on a named import', 'const unused = items.length;\n'],
  ['a member read on a member read', 'const unused = registry.items.length;\n'],
  ['a collection built from an iterable', 'const unused = new Set(items);\n'],
  ['a map built from entries that are not array literals', 'const unused = new Map([items]);\n'],
  ['Array.from', 'const unused = Array.from(items);\n'],
  ['a function that shadows a builtin collection', 'function Set() { registerOverlay(); }\nconst unused = new Set();\n'],
  ['a binding that shadows Object', 'const Object = { freeze: registerOverlay };\nconst unused = Object.freeze({});\n'],
  ['Object.freeze of a binding', 'const unused = Object.freeze(items);\n'],
  ['an array spread', 'const unused = [...items];\n'],
  ['an object spread', getter + 'const unused = { ...box };\n'],
  ['a template that converts an object', converts + 'const unused = `${box}`;\n'],
  ['an operator that converts an object', converts + "const unused = box + '';\n"],
  ['a computed member key that converts an object', converts + 'const unused = { a: 1 }[box];\n'],
  ['a computed object key that converts an object', converts + 'const unused = { [box]: 1 };\n'],
  ['instanceof', 'const unused = Tooltip instanceof Base;\n'],
  ['in', "const unused = 'value' in items;\n"],
  ['delete', 'const unused = delete items.value;\n'],
  ['an optional chain', 'const unused = registry?.items;\n'],
  ['an undeclared global', 'const unused = document;\n'],
  ['a binding read before it is initialised', 'const unused = later;\nconst later = 1;\n'],
  ['a class with a static block', 'const Panel = class { static { registerOverlay(); } };\n'],
  ['a class with a computed member name', "const KEY = 'open';\nconst Panel = class { [KEY]() {} };\n"],
  ['a class extending an import', 'const Panel = class extends Base {};\n'],
  ['a class with a static value that runs code', getter + 'const Panel = class { static value = box.value; };\n'],
  ['await', 'const unused = await items;\n'],
  ['a dynamic import', "const unused = import('./registry.js');\n"],
  ['a destructured binding', getter + 'const { value } = box;\n'],
  ['a using declaration', 'using unused = items;\n'],
  ['a top-level statement that is not a declaration', 'if (items) registerOverlay();\n'],
  ['a property set with a key the check cannot read', "const KEY = 'value';\nconst box = {};\nbox[KEY] = 1;\n"],
  ['a property set on __proto__', 'const box = {};\nbox.__proto__ = { get value() { registerOverlay(); return 0; } };\n'],
  ['a property set on a computed __proto__', "const box = {};\nbox['__proto__'] = items;\n"],
  ['a compound assignment', 'const box = { count: 0 };\nbox.count += 1;\n'],
  ['a logical assignment', 'const box = {};\nbox.value ||= 1;\n'],
  ['a property set through a setter', 'const box = { set value(next) { registerOverlay(); } };\nbox.value = 1;\n'],
  ['a property set on an import', 'items.value = 1;\n'],
  ['a property set on a namespace', 'registry.value = 1;\n'],
  ['a property set on a class instance', 'const instance = /*#__PURE__*/ new Base();\ninstance.value = 1;\n'],
  ['a property set on a frozen value', 'const box = Object.freeze({});\nbox.value = 1;\n'],
  ['a property set on a member', 'const box = { inner: {} };\nbox.inner.value = 1;\n'],
  ['a binding reassigned', 'let box = {};\nbox = items;\n'],
])('the split refuses a value that runs code on load: %s', (_, body) =>
  expect(declarations(body)).toThrow(/peblish:split-mux-declarations: .*may have effects/),
);

test('the forms Mux rc.7 uses at the top level of overlays.js pass', () => {
  const { declarations: parts } = declarations(
    [
      "const useLayout = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;",
      "const GEOMETRY = Object.freeze({ placement: 'bottom', offset: 8, shouldFlip: true });",
      'const DURATION = 5000;',
      'const FOLLOW = undefined;',
      "const PRESETS = ['data-muxui-theme', 'data-muxui-contrast'];",
      'const NONE = {};',
      "const isDom = (element) => typeof element.type === 'string';",
      "const PLACEMENTS = new Set(['top-start', 'top-end']);",
      'const Context = React.createContext(null);',
      'export const Dialog = /*#__PURE__*/ (() => { const component = React.forwardRef(function Dialog() { return null; }); return component; })();',
      'const LABEL = `Tooltip-${DURATION * 2}`;',
      "const NAMES = new Map([['top', GEOMETRY.placement]]);",
      "Tooltip.displayName = 'Tooltip';",
      'function helper() {}',
      "helper.displayName = 'helper';",
      "NONE['key'] = 1;",
    ].join('\n'),
  )();
  expect(parts.size).toBe(14);
});

// A known factory's result keeps its kind through /*#__PURE__*/ and through the wrappers that only look different
// (parentheses, a sequence's last value, TypeScript's `as`, `satisfies` and `!`), so the forms Mux may emit next pass
// and the property set travels with its declaration.
const component = (name: string, factory = 'forwardRef') => `React.${factory}(function ${name}() { return null; })`;
test.each([
  ['an annotated forwardRef', `const Popover = /*#__PURE__*/ ${component('Popover')};\nPopover.displayName = 'Popover';\n`],
  ['an annotated memo', `const Popover = /*#__PURE__*/ ${component('Popover', 'memo')};\nPopover.displayName = 'Popover';\n`],
  [
    'an annotated forwardRef in parentheses',
    `const Popover = /*#__PURE__*/ (${component('Popover')});\nPopover.displayName = 'Popover';\n`,
  ],
  [
    'a factory reached through a sequence',
    "const Popover = /*#__PURE__*/ (0, React.memo)(function Popover() { return null; });\nPopover.displayName = 'Popover';\n",
  ],
  [
    'a factory of React in parentheses',
    "const Popover = (React).forwardRef(function Popover() { return null; });\nPopover.displayName = 'Popover';\n",
  ],
  [
    'a property set in parentheses',
    `const Popover = ${component('Popover')};\n(Popover).displayName = 'Popover';\n(Popover.label = 'Popover');\n`,
  ],
])('a factory result keeps its kind: %s', (_, body) => {
  const { declarations: parts } = declarations(body)();
  expect(parts.get('Popover')?.text).toMatch(/displayName = 'Popover'/);
});

test("Tooltip's own displayName still passes when Mux marks its forwardRef pure", () => {
  const annotated = tooltip.replace('React.forwardRef', '/*#__PURE__*/ React.forwardRef');
  const { declarations: parts } = splitDeclarations('/mux/generated/overlays.js', `${annotated}Tooltip.displayName = 'Tooltip';\n`);
  expect(parts.get('Tooltip')?.text).toMatch(/displayName = 'Tooltip'/);
});

test('the other wrapped forms that run nothing pass', () => {
  const { declarations: parts } = declarations(
    [
      "const GEOMETRY = /*#__PURE__*/ Object.freeze({ placement: 'top' });",
      'const PLACEMENT = GEOMETRY.placement;',
      'const OFFSET = Object.freeze(({ offset: 8 })).offset;',
      "const PLACEMENTS = new Set((['top']));",
      "const NAMES = new Map([(['top', 1])]);",
      "const SERVER = typeof (window) === 'undefined';",
      'const made = /*#__PURE__*/ (registry.make());',
      'const box = (0, { value: 1 });',
      'box.value = 2;',
    ].join('\n'),
  )();
  expect(parts.size).toBe(9);
});

test('TypeScript wrappers are looked through, in a module that is still TypeScript', () => {
  const { declarations: parts } = splitDeclarations(
    '/mux/generated/overlays.ts',
    tooltip +
      [
        `const Popover = ${component('Popover')} as unknown as typeof Tooltip;`,
        "(Popover as typeof Tooltip).displayName = 'Popover';",
        "Popover!.label = 'Popover';",
        "const GEOMETRY = Object.freeze({ placement: 'top' } as const);",
        'const PLACEMENT = GEOMETRY.placement;',
        "const PLACEMENTS = new Set(['top'] satisfies string[]);",
        "const SERVER = typeof (window as unknown) === 'undefined';",
      ].join('\n'),
  );
  expect(parts.get('Popover')?.text).toMatch(/displayName = 'Popover';\nPopover!\.label/);
});

// The wrappers do not open a way past the check: what is unsafe bare is unsafe wrapped.
test.each([
  [
    'a property set on an annotated call of an unknown function',
    "const made = /*#__PURE__*/ registry.make();\nmade.displayName = 'made';\n",
  ],
  ['a property set on one in parentheses', "const made = /*#__PURE__*/ (registry.make());\nmade.displayName = 'made';\n"],
  ['a property set on an annotated new', "const made = /*#__PURE__*/ new registry.Panel();\nmade.displayName = 'made';\n"],
  [
    'a computed key on a factory result',
    `const KEY = 'displayName';\nconst Popover = /*#__PURE__*/ ${component('Popover')};\nPopover[KEY] = 'Popover';\n`,
  ],
  ['__proto__ on a factory result', `const Popover = /*#__PURE__*/ ${component('Popover', 'memo')};\nPopover.__proto__ = items;\n`],
  ['a computed __proto__ on a factory result', `const Popover = /*#__PURE__*/ ${component('Popover')};\nPopover['__proto__'] = items;\n`],
  ['a computed __proto__ in parentheses', `const Popover = ${component('Popover')};\nPopover[('__proto__')] = items;\n`],
  ['an annotation that reaches only the first call of a sequence', 'const made = /*#__PURE__*/ (registry.make(), registerOverlay());\n'],
  ['an annotation that does not reach into the callee', 'const made = /*#__PURE__*/ (registerOverlay(), registry.make)();\n'],
  ['a sequence with a call before a value', 'const unused = (registerOverlay(), 1);\n'],
  ['a sequence with a call before a factory', 'const Popover = (registerOverlay(), React.memo)(function Popover() { return null; });\n'],
  ['a property set through a sequence', "(registerOverlay(), Tooltip).displayName = 'Tooltip';\n"],
  ['typeof through a sequence', "const SERVER = typeof (0, window) === 'undefined';\n"],
  ['typeof in parentheses before initialisation', 'const early = typeof (later);\nconst later = 1;\n'],
  ['an annotated freeze of a binding', 'const box = {};\nconst frozen = /*#__PURE__*/ Object.freeze(box);\nbox.value = 1;\n'],
  ['a property set on an import in parentheses', '(items).value = 1;\n'],
  ['a map from a parenthesised iterable', 'const unused = new Map((items));\n'],
])('the split refuses a wrapped value that runs code on load: %s', (_, body) =>
  expect(declarations(body)).toThrow(/peblish:split-mux-declarations: .*may have effects/),
);

test.each([
  ['a property set on an import', '(items as { value: number }).value = 1;\n'],
  [
    'a getter read through a non-null assertion',
    'const box = { get value() { registerOverlay(); return 0; } };\nconst unused = box!.value;\n',
  ],
])('TypeScript wrappers do not hide an effect: %s', (_, body) =>
  expect(() => splitDeclarations('/mux/generated/overlays.ts', tooltip + registry + body)).toThrow(/may have effects/),
);
