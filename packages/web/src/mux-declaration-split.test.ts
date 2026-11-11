import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { build, type Plugin, type Rolldown } from 'vite';
import { splitMuxDeclarations, splitMuxSubstrate } from '../vite.config.ts';

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
