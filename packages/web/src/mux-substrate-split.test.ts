import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { build, type Rolldown } from 'vite';
import { splitMuxSubstrate } from '../vite.config.ts';

// The client build's split of Mux UI's substrate.js (vite.config.ts) on the vendored package:
// two entries, one with only Button and one with Button and Menu, as two routes would be. React
// Aria's Menu must stay out of what the Button-only entry loads; without the split it does not.
const dir = mkdtempSync(join(tmpdir(), 'peblish-mux-split-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, 'button.js'), "import { Button } from '@muxui/react';\nglobalThis.button = Button;\n");
writeFileSync(join(dir, 'menu.js'), "import { Button, Menu } from '@muxui/react';\nglobalThis.menu = [Button, Menu];\n");
const mux = join(import.meta.dirname, '../../ui/node_modules/@muxui/react/generated/index.mjs');

/** Every module the Button-only entry loads, through its static imports. */
async function buttonEntryModules(split: boolean) {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    root: dir,
    resolve: { alias: { '@muxui/react': mux } },
    plugins: split ? [splitMuxSubstrate()] : [],
    build: {
      write: false,
      minify: false,
      rolldownOptions: { input: { button: join(dir, 'button.js'), menu: join(dir, 'menu.js') }, external: [/^react(-dom)?(\/|$)/] },
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
  visit(chunks.find((chunk) => chunk.isEntry && chunk.name === 'button'));
  expect(loaded.size, 'the Button entry was built').toBeGreaterThan(0);
  return [...loaded].flatMap((chunk) => chunk.moduleIds);
}

const reactAriaMenu = (id: string) => /[\\/]react-aria-components[\\/]dist[\\/]private[\\/]Menu\.mjs$/.test(id);

test('a Button-only entry does not load React Aria Menu once substrate.js is split', { timeout: 60_000 }, async () => {
  const [whole, split] = [await buttonEntryModules(false), await buttonEntryModules(true)];
  expect(whole.some(reactAriaMenu), 'the control: one substrate.js module drags Menu into the shared chunk').toBe(true);
  expect(split.some(reactAriaMenu)).toBe(false);
  expect(split.some((id) => id.endsWith('?mux-substrate=AriaButton'))).toBe(true);
});

test('a Mux file that names substrate.js by another relative path is split too', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'peblish-mux-path-'));
  try {
    const generated = join(root, 'node_modules/@muxui/react/generated');
    mkdirSync(generated, { recursive: true });
    writeFileSync(
      join(generated, 'substrate.js'),
      "import * as RAC from 'react-aria-components';\nfunction withMuxState(component) { return component; }\n" +
        'export const AriaButton = /*#__PURE__*/ withMuxState(RAC.Button);\nexport const AriaMenu = /*#__PURE__*/ withMuxState(RAC.Menu);\n',
    );
    writeFileSync(
      join(generated, 'button.js'),
      "import { AriaButton } from '../generated/substrate.js';\nexport const Button = AriaButton;\n",
    );
    writeFileSync(
      join(root, 'entry.js'),
      `import { Button } from ${JSON.stringify(join(generated, 'button.js'))};\nglobalThis.button = Button;\n`,
    );
    const result = await build({
      configFile: false,
      logLevel: 'silent',
      root,
      plugins: [splitMuxSubstrate()],
      build: { write: false, minify: false, rolldownOptions: { input: join(root, 'entry.js'), external: [/^react-aria-components$/] } },
    });
    const modules = (Array.isArray(result) ? result : [result]).flatMap((output) =>
      'output' in output ? output.output.flatMap((item) => (item.type === 'chunk' ? item.moduleIds : [])) : [],
    );
    expect(modules.some((id) => id.endsWith('substrate.js?mux-substrate=AriaButton'))).toBe(true);
    expect(modules.some((id) => id.endsWith('substrate.js'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
