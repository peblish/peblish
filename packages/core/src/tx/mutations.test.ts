import { globSync } from 'node:fs';
import { join } from 'node:path';
import { eventTypes } from '@peblish/schema/events';
import { expect, test } from 'vitest';
import { policies } from '../registry/policies.gen.ts';
import { mutationInfo } from './mutation.ts';

// Mutation registry: every mutation exported anywhere in core names a registered authz
// action and at least one outbox event type. defineMutation already enforces both at
// compile time; this catches casts and keeps the catalogue honest. Writes outside
// defineMutation are prevented by lint (core-writer-access, core-tx-access).

const src = join(import.meta.dirname, '..');
const modules = globSync('**/*.ts', { cwd: src }).filter(
  (file) => !/\.(test|test-d|gen)\.ts$/.test(file) && !file.startsWith('testing/') && !file.endsWith('-cli.ts'),
);

test('every exported core mutation has an authz action and an outbox event type', async () => {
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
    }
  }
  expect(problems).toEqual([]);
  expect(found).toContain('posts/create.ts#createPost');
});
