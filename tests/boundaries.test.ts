import { join } from 'node:path';
import { cruise } from 'dependency-cruiser';
import extractDepcruiseOptions from 'dependency-cruiser/config-utl/extract-depcruise-options';
import { describe, expect, test } from 'vitest';

// Each fixture under **/__fixtures__/ breaks exactly one boundary. The normal lint run
// excludes them; here they are cruised with the real rules and must fail with that rule.

const root = join(import.meta.dirname, '..');
const fixtures: Record<string, string> = {
  'packages/schema/src/__fixtures__/imports-core.ts': 'schema-is-a-leaf',
  'packages/ui/src/__fixtures__/imports-core.tsx': 'ui-imports-schema-only',
  'packages/web/src/__fixtures__/imports-mux.tsx': 'mux-only-in-ui',
  'packages/web/src/__fixtures__/imports-driver.ts': 'web-no-database',
  'packages/core/src/__fixtures__/imports-fedify.ts': 'fedify-only-in-federation',
  'packages/core/src/__fixtures__/mints-grant.ts': 'authz-brand',
  'packages/core/src/__fixtures__/writes-directly.ts': 'core-writer-access',
};

async function violations(files: string[], { fixtures = false } = {}) {
  const options = await extractDepcruiseOptions(join(root, '.dependency-cruiser.cjs'));
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const { output } = await cruise(files, fixtures ? { ...options, exclude: { path: ['(^|/)node_modules/'] } } : options);
    if (typeof output === 'string') throw new Error('expected a cruise result');
    return output.summary.violations.filter(({ rule }) => rule.name !== 'not-to-unresolvable');
  } finally {
    process.chdir(cwd);
  }
}

describe('package boundaries', () => {
  test('the real packages are clean', async () => {
    expect(await violations(['packages'])).toEqual([]);
  });

  for (const [file, rule] of Object.entries(fixtures)) {
    test(`${file} fails ${rule}`, async () => {
      const found = await violations([file], { fixtures: true });
      expect(found.map(({ from, rule: { name } }) => ({ from, rule: name }))).toContainEqual({ from: file, rule });
    });
  }
});
