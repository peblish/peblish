import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { rewriteSubstrateImports, splitDeclarations, splitSubstrate } from '../vite.config.ts';

// The fail-closed shape checks of the client build's substrate.js split (vite.config.ts), on small sources:
// a shape the split cannot express must fail the build instead of shipping a module that reads a missing name.
const head = "import * as RAC from 'react-aria-components';\nfunction withMuxState(component, element) { return component; }\n";
const button = "export const AriaButton = /*#__PURE__*/ withMuxState(RAC.Button, 'button');\n";
const split = (body: string) => () => splitSubstrate('/mux/generated/substrate.js', head + button + body);
const rewrite = (code: string) => () => rewriteSubstrateImports('/mux/generated/button.js', code);

describe('splitSubstrate', () => {
  test('names that only look like a wrapper pass: property names, object keys and strings', () => {
    const { wrappers, names } = split(
      "const label = { AriaButton: 'AriaButton' }.AriaButton;\nexport const AriaMenu = /*#__PURE__*/ withMuxState(RAC.AriaButton, label);\n",
    )();
    expect([...wrappers.keys()]).toEqual(['AriaButton', 'AriaMenu']);
    expect(names).toBe('withMuxState, label');
  });

  test.each([
    [
      'a wrapper declared as another',
      'export const AriaCheckboxButton = AriaButton;\n',
      'AriaCheckboxButton reading the exported wrapper AriaButton',
    ],
    [
      'a wrapper reading another inside a function',
      'export const AriaLink = /*#__PURE__*/ withMuxState(() => AriaButton, "a");\n',
      'AriaLink reading the exported wrapper AriaButton',
    ],
    ['a helper reading a wrapper', 'const tags = { [AriaButton]: "button" };\n', 'a helper reading the exported wrapper AriaButton'],
    ['a class helper', 'class Helper {}\n', 'a top-level ClassDeclaration'],
    ['a side-effect statement', 'RAC.setup();\n', 'a top-level ExpressionStatement'],
    // Left out of the client when no route imports it, an unmarked call would run on the server only.
    [
      'a wrapper made by an unmarked call',
      "export const AriaLink = withMuxState(RAC.Link, 'a');\n",
      'a top-level value that may have effects',
    ],
    ['a helper made by a call', 'const registry = RAC.register();\n', 'a top-level value that may have effects'],
  ])('rejects %s', (_, body, error) => expect(split(body)).toThrow(error));
});

describe('rewriteSubstrateImports', () => {
  test('points a named import at its wrapper module', () => {
    expect(rewriteSubstrateImports('/mux/generated/button.js', "import { AriaButton as B } from './substrate.js';\nB;\n")?.code).toBe(
      'import { AriaButton as B } from "/mux/generated/substrate.js?mux-substrate=AriaButton";\nB;\n',
    );
  });

  test.each(["import './substrate.js';\n", "import {} from './substrate.js';\n"])('rejects the side-effect-only %s', (code) =>
    expect(rewrite(code)).toThrow('a side-effect-only import of substrate.js'),
  );

  test('rewrites the named imports overlays.js makes, aliases included', () => {
    const code = "import { AriaDropZone, AriaToastRegion as UNSTABLE_ToastRegion } from './substrate.js';\n";
    expect(rewriteSubstrateImports('/mux/generated/overlays.js', code)?.code).toBe(
      'import { AriaDropZone as AriaDropZone } from "/mux/generated/substrate.js?mux-substrate=AriaDropZone"; ' +
        'import { AriaToastRegion as UNSTABLE_ToastRegion } from "/mux/generated/substrate.js?mux-substrate=AriaToastRegion";\n',
    );
  });

  test.each(['././substrate.js', '../generated/substrate.js', '/mux/generated/substrate.js'])(
    'resolves the path %s to substrate.js and rewrites it',
    (path) =>
      expect(rewrite(`import { AriaButton } from '${path}';\n`)()?.code).toBe(
        'import { AriaButton as AriaButton } from "/mux/generated/substrate.js?mux-substrate=AriaButton";\n',
      ),
  );

  test('leaves a different module alone', () =>
    expect(rewrite("import { a } from './substrate-motion.mjs';\nimport { b } from '../other/substrate.js';\n")()).toBeNull());

  // Each would load substrate.js whole, so the split would silently stop working.
  test.each([
    ['a dynamic import', "const load = () => import('./substrate.js');\n", 'a dynamic import of substrate.js'],
    ['a dynamic import through a template', 'const load = () => import(`./substrate.js`);\n', 'a reference to substrate.js'],
    ['a dynamic import by another path', "const load = () => import('././substrate.js');\n", 'a dynamic import of substrate.js'],
    ['a re-export', "export { AriaButton } from './substrate.js';\n", 'a re-export of substrate.js'],
    ['a re-export by another path', "export * from '././substrate.js';\n", 'a re-export of substrate.js'],
    ['a namespace import', "import * as substrate from './substrate.js';\n", 'a namespace import of substrate.js'],
    ['a default import', "import substrate from './substrate.js';\n", 'a default or string-named import of substrate.js'],
    ['a string-named import', "import { 'AriaButton' as B } from './substrate.js';\n", 'a default or string-named import of substrate.js'],
    ['an import with attributes', "import { AriaButton } from './substrate.js' with { type: 'js' };\n", 'with a phase or attributes'],
    ['a path handed to code', "const url = new URL('./substrate.js', import.meta.url);\n", 'a reference to substrate.js'],
    ['an import without the extension', "import { AriaButton } from './substrate';\n", "as './substrate', which the split cannot rewrite"],
    ['an import with a query', "import { AriaButton } from './substrate.js?raw';\n", 'which the split cannot rewrite'],
    ['an import by package path', "import { AriaButton } from '@muxui/react/generated/substrate.js';\n", 'which the split cannot rewrite'],
  ])('rejects %s', (_, code, error) => expect(rewrite(code)).toThrow(error));
});

// The vendored rc.7 files pass every check and split into the parts the client build has always had.
describe('the vendored Mux UI files', () => {
  const generated = join(import.meta.dirname, '../../ui/node_modules/@muxui/react/generated');
  test('substrate.js splits into 81 wrappers', () => expect(splitSubstrate(join(generated, 'substrate.js')).wrappers.size).toBe(81));
  test('overlays.js splits into 48 declarations, 9 of them exported', () => {
    const { declarations } = splitDeclarations(join(generated, 'overlays.js'));
    expect(declarations.size).toBe(48);
    expect([...declarations.values()].filter(({ exported }) => exported)).toHaveLength(9);
  });
});
