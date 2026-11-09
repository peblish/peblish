import { join } from 'node:path';
import { cruise } from 'dependency-cruiser';
import extractDepcruiseOptions from 'dependency-cruiser/config-utl/extract-depcruise-options';
import { describe, expect, test } from 'vitest';

// Each fixture under **/__fixtures__/ breaks one boundary (a few break a second one on the
// way). The normal lint run does not cruise them; here they are cruised with the real rules
// and must fail with that rule.

const root = join(import.meta.dirname, '..');
const fixtures: Record<string, string> = {
  'packages/schema/src/__fixtures__/imports-core.ts': 'schema-is-a-leaf',
  'packages/ui/src/__fixtures__/imports-core.tsx': 'ui-imports-schema-only',
  'packages/core/src/__fixtures__/imports-federation.ts': 'core-imports-schema-only',
  'packages/federation/src/__fixtures__/imports-ui.ts': 'federation-imports-core-and-schema',
  'packages/web/src/__fixtures__/imports-federation-internals.ts': 'web-federation-entry-points',
  'packages/web/src/__fixtures__/imports-mux.tsx': 'mux-only-in-ui',
  'packages/web/src/__fixtures__/imports-mux-resolved.tsx': 'mux-only-in-ui',
  'packages/web/src/__fixtures__/imports-mux-css.ts': 'mux-only-in-ui',
  'packages/web/src/__fixtures__/imports-rac-resolved.tsx': 'mux-only-in-ui',
  'packages/web/src/__fixtures__/imports-driver.ts': 'web-no-database',
  'packages/web/src/__fixtures__/imports-core-db.ts': 'web-no-database',
  'packages/core/src/__fixtures__/imports-fedify.ts': 'fedify-only-in-federation',
  'packages/core/src/__fixtures__/imports-fedify-resolved.ts': 'fedify-only-in-federation',
  'packages/core/src/__fixtures__/service-imports-driver.ts': 'driver-only-in-core-db',
  'packages/core/src/__fixtures__/mints-grant.ts': 'authz-brand',
  'packages/core/src/__fixtures__/writes-directly.ts': 'core-writer-access',
  'packages/core/src/__fixtures__/opens-tx.ts': 'core-tx-access',
  'packages/core/src/__fixtures__/imports-test-helper.ts': 'no-test-helpers-in-product',
  'packages/core/src/__fixtures__/imports-test-file.ts': 'no-test-helpers-in-product',
  'packages/core/src/__fixtures__/imports-fixture.ts': 'no-test-helpers-in-product',
  'packages/core/src/outbox/__fixtures__/reexports-writer.ts': 'no-guarded-reexports',
  'packages/core/src/__fixtures__/cycle-a.ts': 'no-circular',
  'packages/core/src/__fixtures__/imports-tool.ts': 'nothing-imports-tools',
  'packages/core/src/__fixtures__/imports-missing.ts': 'not-to-unresolvable',
};
/** Fixtures that must pass: the exemptions the rules promise. */
const allowed = ['packages/core/src/__fixtures__/writes-by-type.ts'];

async function violations(files: string[], { fixtures = false } = {}) {
  const options = await extractDepcruiseOptions(join(root, '.dependency-cruiser.cjs'));
  const cwd = process.cwd();
  process.chdir(root);
  try {
    // Fixture runs follow fixture-to-fixture imports (the cycle), which the normal run does not.
    const { output } = await cruise(files, fixtures ? { ...options, doNotFollow: { path: ['node_modules'] } } : options);
    if (typeof output === 'string') throw new Error('expected a cruise result');
    return output.summary.violations;
  } finally {
    process.chdir(cwd);
  }
}

describe('package boundaries', () => {
  test('the real packages are clean', async () => {
    expect(await violations(['packages'])).toEqual([]);
  });

  test.each(allowed)('%s passes', async (file) => {
    expect(await violations([file], { fixtures: true })).toEqual([]);
  });

  test('every rule has a fixture that fails it', async () => {
    const options = await extractDepcruiseOptions(join(root, '.dependency-cruiser.cjs'));
    const rules = (options.ruleSet?.forbidden ?? []).map(({ name }) => name);
    expect(rules.length).toBeGreaterThan(10);
    expect(rules.filter((name) => !Object.values(fixtures).includes(name ?? ''))).toEqual([]);
  });

  for (const [file, rule] of Object.entries(fixtures)) {
    test(`${file} fails ${rule}`, async () => {
      const found = await violations([file], { fixtures: true });
      expect(found.map(({ from, rule: { name } }) => ({ from, rule: name }))).toContainEqual({ from: file, rule });
    });
  }
});
