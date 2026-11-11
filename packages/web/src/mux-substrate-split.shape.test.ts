import { describe, expect, test } from 'vitest';
import { rewriteSubstrateImports, splitSubstrate } from '../vite.config.ts';

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
});
