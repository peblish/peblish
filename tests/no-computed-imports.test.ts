import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

// The boundary lint sees only static imports. A computed import() or a require() could reach
// any module unseen, so product sources may not use them.

const root = join(import.meta.dirname, '..');
/** `file: reason`. Empty: no product module needs one yet. */
const allowlist = new Set<string>();

/** The computed imports in one source file, as `kind at line`. */
function computedImports(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const at = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const [argument] = node.arguments;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && !(argument && ts.isStringLiteralLike(argument))) {
        found.push(`import() with a computed specifier at line ${at(node)}`);
      }
      if (ts.isIdentifier(node.expression) && (node.expression.text === 'require' || node.expression.text === 'createRequire')) {
        found.push(`${node.expression.text}() at line ${at(node)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const skipped = /(^|\/)(__fixtures__|node_modules)\/|^packages\/core\/src\/(testing|fixtures)\/|\.(test|test-d)\.tsx?$/;

function productSources(): string[] {
  return readdirSync(join(root, 'packages'))
    .flatMap((name) =>
      readdirSync(join(root, 'packages', name, 'src'), { recursive: true, encoding: 'utf8' }).map((file) => `packages/${name}/src/${file}`),
    )
    .filter((file) => /\.tsx?$/.test(file) && !skipped.test(file));
}

describe('no computed imports', () => {
  test('the checker finds each form', () => {
    const text = [
      "await import('./literal.ts');",
      'await import(`./literal.ts`);',
      'await import(name);',
      'await import(`./${name}.ts`);',
      "require('postgres');",
      'createRequire(import.meta.url);',
    ].join('\n');
    expect(computedImports('sample.ts', text)).toEqual([
      'import() with a computed specifier at line 3',
      'import() with a computed specifier at line 4',
      'require() at line 5',
      'createRequire() at line 6',
    ]);
  });

  test('product sources have none outside the allowlist', () => {
    const files = productSources();
    expect(files.length).toBeGreaterThan(20);
    const found = files
      .filter((file) => !allowlist.has(file))
      .flatMap((file) => computedImports(file, readFileSync(join(root, file), 'utf8')).map((finding) => `${file}: ${finding}`));
    expect(found).toEqual([]);
  });
});
