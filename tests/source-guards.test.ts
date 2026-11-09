import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { sourceGuardFindings } from './source-guards.ts';

// Runs tests/source-guards.ts over every product source, after proving on snippets that it
// catches each form (negative controls) and passes legitimate code (positive controls).

const root = join(import.meta.dirname, '..');
/** Product files exempt from the guards, as `path: reason`. Empty: none needs one. */
const allowlist = new Map<string, string>();
/** Snippets are checked as if they lived in a core service. */
const sample = 'packages/core/src/posts/sample.ts';

const findings = (...lines: string[]) => sourceGuardFindings(sample, lines.join('\n'));

describe('source guards: negative controls', () => {
  test.each([
    ['computed import()', 'await import(name);'],
    ['computed template import()', 'await import(`./${name}.ts`);'],
    ['require', "require('postgres');"],
    ['require as a value', 'const load = require;'],
    ['import = require', "import load = require('postgres');"],
    ['createRequire, named', "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url);"],
    [
      'createRequire, aliased (the verified bypass)',
      "import { createRequire as cr } from 'node:module';\nconst load = cr(import.meta.url);\nload('../authz/brand.ts');",
    ],
    ['node:module, namespace', "import * as m from 'node:module';\nm.createRequire(import.meta.url);"],
    ['module, default', "import mod from 'module';\nmod.createRequire(import.meta.url);"],
    ['node:module, side effect', "import 'node:module';"],
    ['node:module, literal import()', "const { createRequire } = await import('node:module');"],
    ['node:module re-export', "export { createRequire } from 'node:module';"],
    ['getBuiltinModule', "process.getBuiltinModule('module');"],
    ['getBuiltinModule through globalThis', "globalThis.process.getBuiltinModule('node:module');"],
    ['getBuiltinModule destructured', 'const { getBuiltinModule: load } = process;'],
    ['getBuiltinModule by string', "Reflect.get(process, 'getBuiltinModule');"],
    ['computed member on process', 'process[key];'],
    ['computed member on globalThis', 'globalThis[key];'],
    ['eval', "eval('1');"],
    ['indirect eval', "(0, globalThis.eval)('1');"],
    ['new Function', "new Function('return 1');"],
    ['Function()', "Function('return 1')();"],
    ['the Function constructor by another name', "(() => {}).constructor('return 1');"],
    ['["constructor"]', "(() => {})['constructor'];"],
    ['node:vm', "import vm from 'node:vm';\nvm.runInThisContext('1');"],
    ['vm, named', "import { runInNewContext } from 'vm';\nrunInNewContext('1');"],
    ['module.exports', 'module.exports = {};'],
    ['exports', 'exports.value = 1;'],
    ['export =', 'export = {};'],
    ['export { writer }', "import { writer } from '../db/write.ts';\nexport { writer };"],
    ['export { writer as w }', "import { writer } from '../db/write.ts';\nexport { writer as w };"],
    ['export const w = writer', "import { writer } from '../db/write.ts';\nexport const w = writer;"],
    ['export default writer', "import { writer } from '../db/write.ts';\nexport default writer;"],
    ['module.exports = writer', "import { writer } from '../db/write.ts';\nmodule.exports = writer;"],
    ['writer in an object', "import { writer } from '../db/write.ts';\nexport const api = { writer };"],
    ['writer returned', "import { writer } from '../db/write.ts';\nexport const get = () => writer;"],
    ['writer bound', "import { writer } from '../db/write.ts';\nexport const w = writer.bind(null);"],
    ['writer aliased on import', "import { writer as w } from '../db/write.ts';\nexport const x = w;"],
    ['write pool namespace exported', "import * as write from '../db/write.ts';\nexport { write };"],
    ['write pool namespace member as a value', "import * as write from '../db/write.ts';\nexport const w = write.writer;"],
    ['writePool by package path', "import { writePool } from '@peblish/core/db/pools';\nexport const p = writePool;"],
    ['issueGrant exported', "import { issueGrant } from '../authz/brand.ts';\nexport { issueGrant };"],
    ['issueGrant passed on', "import { issueGrant } from '../authz/brand.ts';\nregister(issueGrant);"],
    ['authorize default-exported', "import { authorize } from '../authz/authorize.ts';\nexport default authorize;"],
    ['re-export of the write pool', "export { writer } from '../db/write.ts';"],
    ['re-export star of brand', "export * from '../authz/brand.ts';"],
    ['re-export namespace of pools', "export * as pools from '../db/pools.ts';"],
    ['literal import() of the write pool', "const { writer } = await import('../db/write.ts');"],
  ])('%s is rejected', (_name, code) => {
    expect(findings(code)).not.toEqual([]);
  });

  test('a finding names the form and the line', () => {
    expect(findings("import { createRequire as cr } from 'node:module';", 'const load = cr(import.meta.url);')).toEqual([
      'runtime import of node:module at line 1',
    ]);
    expect(findings("import { writer } from '../db/write.ts';", 'export { writer };')).toEqual([
      'export of writer from ../db/write.ts at line 2',
    ]);
  });
});

describe('source guards: positive controls', () => {
  test.each([
    ['literal import()', "await import('./literal.ts');\nawait import(`./literal.ts`);"],
    ['calling the write pool', "import { writer } from '../db/write.ts';\nexport const run = () => writer().transaction(async () => {});"],
    ['calling through call()', "import { writer } from '../db/write.ts';\nwriter.call(undefined);"],
    ['calling a namespace member', "import * as write from '../db/write.ts';\nwrite.writer();"],
    ['a static method of the brand', "import { Authorized } from '../authz/brand.ts';\nAuthorized.verify(grant, 'post.create');"],
    ['calling authorize()', "import { authorize } from '../authz/authorize.ts';\nawait authorize('post.create', principal, subject);"],
    ['type-only import and export', "import type { WriteTx } from '../db/write.ts';\nexport type T = WriteTx;\nexport type { WriteTx };"],
    ['type-only specifier', "import { type WriteTx, writer } from '../db/write.ts';\nexport type T = WriteTx;\nwriter();"],
    ['type-only re-export', "export type { Authorized } from '../authz/brand.ts';\nexport { type WriteTx } from '../db/write.ts';"],
    ['typeof in a type', "import { writer } from '../db/write.ts';\nexport type W = typeof writer;"],
    ['type-only node:module', "import type { Module } from 'node:module';\nexport type M = Module;"],
    ['a Function type', 'export const run = (fn: Function) => fn;'],
    [
      'ordinary modules and members',
      "import { eq } from 'drizzle-orm';\nimport { readFileSync } from 'node:fs';\nexport const x = { eq, readFileSync, key: process.env.KEY };",
    ],
    [
      'exporting a function that calls the pool',
      "import { writePool } from '../db/pools.ts';\nexport async function listen() { return writePool().client; }",
    ],
  ])('%s passes', (_name, code) => {
    expect(findings(code)).toEqual([]);
  });
});

const skipped = /(^|\/)(__fixtures__|node_modules)\/|^packages\/core\/src\/(testing|fixtures)\/|\.(test|test-d)\.tsx?$/;

function productSources(): string[] {
  return readdirSync(join(root, 'packages'))
    .flatMap((name) =>
      readdirSync(join(root, 'packages', name, 'src'), { recursive: true, encoding: 'utf8' }).map((file) => `packages/${name}/src/${file}`),
    )
    .filter((file) => /\.tsx?$/.test(file) && !skipped.test(file));
}

test('product sources pass the source guards', () => {
  const files = productSources();
  expect(files.length).toBeGreaterThan(20);
  const found = files
    .filter((file) => !allowlist.has(file))
    .flatMap((file) => sourceGuardFindings(file, readFileSync(join(root, file), 'utf8')).map((finding) => `${file}: ${finding}`));
  expect(found).toEqual([]);
});
