import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { boundaryWanted } from './log-boundary.ts';

test('every build gets the boundary; only the Vite dev server goes without', () => {
  expect(boundaryWanted(false)).toBe(true);
  expect(boundaryWanted(undefined)).toBe(true);
  expect(boundaryWanted(true)).toBe(false);
});

test('the gate reads the build-or-serve constant, never NODE_ENV or import.meta.env', () => {
  const source = readFileSync(join(import.meta.dirname, 'log-boundary-install.ts'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  expect(code).toContain('__PEBLISH_DEV_SERVER__');
  expect(code).not.toMatch(/import\.meta\.env|process\.env|NODE_ENV/);
  const config = readFileSync(join(import.meta.dirname, '../../vite.config.ts'), 'utf8');
  expect(config).toMatch(/__PEBLISH_DEV_SERVER__: JSON\.stringify\(command === 'serve'\)/);
});
