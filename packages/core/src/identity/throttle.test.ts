import { sql } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { throttles } from './tables.ts';
import { addressKey, attempt } from './throttle.ts';

beforeEach(truncateAll);

const allowed = async (count: number, keys: Parameters<typeof attempt>[1]) => {
  const results: boolean[] = [];
  for (let i = 0; i < count; i++) results.push((await attempt('sign-in', keys)).allowed);
  return results;
};

test('an account gets five sign-in attempts per window; refused ones count too; others are unaffected', async () => {
  expect(await allowed(7, { id: 'Mira@Example.test' })).toEqual([true, true, true, true, true, false, false]);
  expect(await allowed(1, { id: ' mira@example.test ' })).toEqual([false]);
  expect(await allowed(1, { id: 'lena@example.test' })).toEqual([true]);
  // Once the window has run its 15 minutes, the count starts again.
  await writer()
    .update(throttles)
    .set({ windowStart: sql`now() - interval '15 minutes'` });
  expect(await allowed(1, { id: 'mira@example.test' })).toEqual([true]);
});

test('an address and an account are counted apart, and one over budget refuses the attempt', async () => {
  // Ten accounts tried from one address: its eleventh attempt is refused, a new address is not.
  for (let i = 0; i < 10; i++) expect((await attempt('sign-in', { ip: '203.0.113.7', id: `user${i}` })).allowed).toBe(true);
  expect((await attempt('sign-in', { ip: '203.0.113.7', id: 'user10' })).allowed).toBe(false);
  expect((await attempt('sign-in', { ip: '203.0.113.8', id: 'user11' })).allowed).toBe(true);
});

test('a refunded attempt is not counted, so only failures use the budget', async () => {
  for (let i = 0; i < 20; i++) await (await attempt('sign-in', { ip: '203.0.113.7', id: 'mira' })).refund();
  expect(await allowed(5, { ip: '203.0.113.7', id: 'mira' })).toEqual([true, true, true, true, true]);
});

test('attempts racing on one key: exactly the budget gets through', async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => attempt('sign-in', { id: 'mira' })));
  expect(results.filter((result) => result.allowed)).toHaveLength(5);
});

test('addresses: IPv6 by its /64, however it is written; IPv4 also when mapped', () => {
  expect(addressKey('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe('2001:db8:85a3:8d3::/64');
  expect(addressKey('2001:0db8:85a3:08d3::1')).toBe('2001:db8:85a3:8d3::/64');
  expect(addressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
  expect(addressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  expect(addressKey('203.0.113.7')).toBe('203.0.113.7');
});

test('link previews: 20 per account and 30 per address in ten minutes', async () => {
  const run = async (count: number, keys: Parameters<typeof attempt>[1]) => {
    const results: boolean[] = [];
    for (let i = 0; i < count; i++) results.push((await attempt('link-preview', keys)).allowed);
    return results;
  };
  expect((await run(21, { id: 'mira' })).filter(Boolean)).toHaveLength(20);
  // Many accounts behind one address: the address is refused from its 31st preview.
  for (let i = 0; i < 30; i++) expect((await attempt('link-preview', { ip: '203.0.113.9', id: `user${i}` })).allowed).toBe(true);
  expect((await attempt('link-preview', { ip: '203.0.113.9', id: 'user30' })).allowed).toBe(false);
});
