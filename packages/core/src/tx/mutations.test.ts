import { globSync } from 'node:fs';
import { join } from 'node:path';
import { eventTypes } from '@peblish/schema/events';
import { expect, test } from 'vitest';
import { policies } from '../registry/policies.gen.ts';
import { defineMutation, mutationInfo, requiresRecheck } from './mutation.ts';

// Mutation registry: every mutation exported anywhere in core names a registered authz
// action and at least one outbox event type, and the actions a moderator or a lock can
// revoke recheck their policy inside the transaction. defineMutation already enforces the
// first two at compile time; this catches casts and keeps the catalogue honest. Writes
// outside defineMutation are prevented by lint (core-writer-access, core-tx-access).

const src = join(import.meta.dirname, '..');
const modules = globSync('**/*.ts', { cwd: src }).filter(
  (file) => !/\.(test|test-d|gen)\.ts$/.test(file) && !/(^|\/)(testing|__fixtures__)\//.test(file) && !file.endsWith('-cli.ts'),
);

test('every exported core mutation has an authz action, an outbox event type and its required recheck', async () => {
  const found: string[] = [];
  const problems: string[] = [];
  for (const file of modules) {
    const exports: Record<string, unknown> = await import(join(src, file));
    for (const [name, value] of Object.entries(exports)) {
      const info = mutationInfo(value);
      if (!info) continue;
      found.push(`${file}#${name}`);
      if (!Object.hasOwn(policies, info.action)) problems.push(`${file}#${name}: no authz action ${info.action}`);
      if (info.emits.length === 0) problems.push(`${file}#${name}: emits no outbox event`);
      for (const type of info.emits) if (!eventTypes.includes(type)) problems.push(`${file}#${name}: unknown event ${type}`);
      if (requiresRecheck(info.action) && !info.recheck) problems.push(`${file}#${name}: ${info.action} must set recheck: true`);
    }
  }
  expect(problems).toEqual([]);
  expect(found).toContain('posts/create.ts#createPost');
});

test('a revocable mutation without recheck throws at definition, even unexported behind a wrapper', () => {
  // @ts-expect-error: post.create can be revoked, so recheck: true is required
  const wrapped = () => defineMutation({ action: 'post.create', emits: ['post.created'], run: async () => null });
  expect(wrapped).toThrow(/must set recheck: true/);
  expect(() => defineMutation({ action: 'vote.cast', emits: ['vote.cast'], run: async () => null })).not.toThrow();
});
