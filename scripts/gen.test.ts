import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, expect, test } from 'vitest';

// Registration by glob: adding a matching file registers it; tests, generated files and
// `_`-prefixed helpers do not. Every binding is prefixed, so any file name generates valid code.
const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'peblish-gen-'));
  roots.push(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const run = () =>
    execFileSync(process.execPath, [join(import.meta.dirname, 'gen.ts')], { env: { ...process.env, GEN_ROOT: root }, stdio: 'pipe' });
  return { root, run, read: (path: string) => readFileSync(join(root, path), 'utf8') };
}

test('pnpm gen registers files by glob, with prefixed bindings', () => {
  const { run, read } = tree({
    'packages/core/src/notifications/consumer.ts': '',
    'packages/core/src/notifications/mentions/consumer.ts': '',
    'packages/core/src/blocks/feed-predicate.ts': '',
    'packages/core/src/blocks/deep/feed-predicate.ts': '',
    'packages/core/src/authz/actions/posts.ts': '',
    'packages/core/src/authz/actions/policies.ts': '',
    'packages/core/src/authz/actions/posts.test.ts': '',
    'packages/core/src/authz/actions/_shared.ts': '',
    'packages/schema/src/events/posts.ts': '',
    'packages/schema/src/refusals/common.ts': '',
    'packages/federation/src/inbound/handlers/create.ts': '',
    'packages/federation/src/inbound/handlers/delete.ts': '',
    'packages/federation/src/delivery/consumer.ts': '',
    'packages/core/src/throttles/job.ts': '',
    'packages/federation/src/delivery/job.ts': '',
    'packages/web/src/i18n/shell.json': '{}',
  });
  run();

  const consumers = read('packages/core/src/registry/consumers.gen.ts');
  expect(consumers).toContain("import { consumer as r_notifications } from '../notifications/consumer.ts';");
  expect(consumers).toContain('export const consumers: readonly Consumer[] = [r_notifications, r_notifications_mentions];');
  // Feed predicates are one per area: <area>/feed-predicate.ts, not deeper.
  expect(read('packages/core/src/registry/feed-predicates.gen.ts')).toContain(
    'export const feedPredicates: readonly FeedPredicate[] = [r_blocks];',
  );
  // An area file named after the registry's own export no longer redeclares it.
  const policies = read('packages/core/src/registry/policies.gen.ts');
  expect(policies).toContain("import { policies as r_policies } from '../authz/actions/policies.ts';");
  expect(policies).toContain('export const policies = { ...r_policies, ...r_posts };');
  expect(policies).not.toMatch(/test|_shared/);
  expect(read('packages/schema/src/registry/events.gen.ts')).toContain("export const eventAreas = { 'posts': r_posts };");
  // A handler named after a reserved word.
  expect(read('packages/federation/src/registry/inbound-handlers.gen.ts')).toContain('[r_create, r_delete]');
  expect(read('packages/federation/src/registry/consumers.gen.ts')).toContain(
    "import type { Consumer } from '@peblish/core/outbox/consumers';",
  );
  expect(read('packages/federation/src/registry/consumers.gen.ts')).toContain(
    'export const federationConsumers: readonly Consumer[] = [r_delivery];',
  );
  // Jobs register like consumers, one list per package.
  const jobs = read('packages/core/src/registry/jobs.gen.ts');
  expect(jobs).toContain("import type { Job } from '../outbox/jobs.ts';");
  expect(jobs).toContain("import { job as r_throttles } from '../throttles/job.ts';");
  expect(jobs).toContain('export const jobs: readonly Job[] = [r_throttles];');
  expect(read('packages/federation/src/registry/jobs.gen.ts')).toContain('export const federationJobs: readonly Job[] = [r_delivery];');
  expect(read('packages/web/src/registry/i18n.gen.ts')).toContain("import r_shell from '../i18n/shell.json';");
});

test('two files with the same key fail the generator', () => {
  const { run } = tree({ 'packages/core/src/authz/actions/a-b.ts': '', 'packages/core/src/authz/actions/a_b.ts': '' });
  expect(run).toThrow(/a-b\.ts and .*a_b\.ts both register as 'a_b'/);
});
