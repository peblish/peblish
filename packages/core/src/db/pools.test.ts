import { expect, test } from 'vitest';
import { readPool, writePool } from './pools.ts';

// The pools' startup parameters. postgres.js drops a falsy value (a boolean false), so a
// parameter that turns something off must be a string, and a slip there fails silently.

const setting = async ({ client }: ReturnType<typeof readPool>, name: string) => (await client.unsafe(`show ${name}`))[0]?.[name];

test('the read pool is read-only with JIT off', async () => {
  expect(await setting(readPool(), 'default_transaction_read_only')).toBe('on');
  expect(await setting(readPool(), 'jit')).toBe('off');
});

test('the write pool is not read-only', async () => {
  expect(await setting(writePool(), 'default_transaction_read_only')).toBe('off');
});
