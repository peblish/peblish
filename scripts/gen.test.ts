import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, expect, test } from 'vitest';

// Registration by glob: adding a matching file registers it; tests and other files do not.
const root = mkdtempSync(join(tmpdir(), 'peblish-gen-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function touch(path: string, body = 'export {};\n') {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

test('pnpm gen registers files by glob', () => {
  touch('packages/core/src/notifications/consumer.ts');
  touch('packages/core/src/notifications/mentions/consumer.ts');
  touch('packages/core/src/blocks/feed-predicate.ts');
  touch('packages/core/src/blocks/deep/feed-predicate.ts');
  touch('packages/core/src/authz/actions/posts.ts');
  touch('packages/core/src/authz/actions/posts.test.ts');
  touch('packages/schema/src/events/posts.ts');
  touch('packages/schema/src/refusals/common.ts');
  touch('packages/federation/src/inbound/handlers/create.ts');
  touch('packages/web/src/i18n/shell.json', '{}');
  execFileSync(process.execPath, [join(import.meta.dirname, 'gen.ts')], { env: { ...process.env, GEN_ROOT: root } });
  const read = (path: string) => readFileSync(join(root, path), 'utf8');

  expect(read('packages/core/src/registry/consumers.gen.ts')).toContain(
    "import { consumer as notifications } from '../notifications/consumer.ts';\nimport { consumer as notifications_mentions } from '../notifications/mentions/consumer.ts';",
  );
  expect(read('packages/core/src/registry/consumers.gen.ts')).toContain(
    'export const consumers: readonly Consumer[] = [notifications, notifications_mentions];',
  );
  // Feed predicates are one per area: <area>/feed-predicate.ts, not deeper.
  expect(read('packages/core/src/registry/feed-predicates.gen.ts')).toContain(
    'export const feedPredicates: readonly FeedPredicate[] = [blocks];',
  );
  expect(read('packages/core/src/registry/policies.gen.ts')).toContain('export const policies = { ...posts };');
  expect(read('packages/core/src/registry/policies.gen.ts')).not.toContain('test');
  expect(read('packages/schema/src/registry/events.gen.ts')).toContain('export const eventAreas = { posts };');
  expect(read('packages/federation/src/registry/inbound-handlers.gen.ts')).toContain('[create]');
  expect(read('packages/web/src/registry/i18n.gen.ts')).toContain("import shell from '../i18n/shell.json';");
});
