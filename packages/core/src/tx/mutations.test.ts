import { globSync } from 'node:fs';
import { join } from 'node:path';
import { eventTypes } from '@peblish/schema/events';
import { expect, test } from 'vitest';
import { policies } from '../registry/policies.gen.ts';
import { mutationInfo } from './mutation.ts';

// Mutation registry: every mutation exported anywhere in core names a registered authz
// action and at least one outbox event type, and the actions a moderator or a lock can
// revoke recheck their policy inside the transaction. defineMutation already enforces the
// first two at compile time; this catches casts and keeps the catalogue honest. Writes
// outside defineMutation are prevented by lint (core-writer-access, core-tx-access).

const src = join(import.meta.dirname, '..');
const mustRecheck = (action: string) => action === 'post.create' || action === 'comment.create' || action.startsWith('mod.');
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
      if (mustRecheck(info.action) && !info.recheck) problems.push(`${file}#${name}: ${info.action} must set recheck: true`);
    }
  }
  expect(problems).toEqual([]);
  expect(found).toContain('posts/create.ts#createPost');
});
