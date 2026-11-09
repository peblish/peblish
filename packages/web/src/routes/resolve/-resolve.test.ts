import { budgets } from '@peblish/core/identity/throttle';
import type { Held } from '@peblish/core/resolve/outcome';
import { describe, expect, test } from 'vitest';
import { answer } from './-answer.ts';
import { pageOf, resolveForm, type Deps, type Who } from './-resolve.ts';

const actor = {
  id: '0192f2c0-0000-7000-8000-000000000001',
  apId: 'https://lemmy.test/c/lab',
  kind: 'Group',
  name: 'lab',
  displayName: null,
  local: false,
  handle: 'lab@lemmy.test',
} as const;
const postId = '0192f2c0-0000-7000-8000-000000000002';
const commentId = '0192f2c0-0000-7000-8000-000000000003';
const who: Who = { actorId: 'a1', emailVerified: true, ip: '203.0.113.7' };

/** Deps that record the order they are called in, with everything permitted unless a test changes it. */
function world(change: Partial<Deps> = {}, counted: { allowed: number } = { allowed: Infinity }) {
  const calls: string[] = [];
  const deps: Deps = {
    held: async () => (calls.push('held'), null),
    here: async () => (calls.push('here'), false),
    enabled: async () => (calls.push('enabled'), true),
    blocked: async (host) => (calls.push(`blocked ${host}`), false),
    count: async () => (calls.push('count'), counted.allowed-- > 0),
    resolve: async () => (calls.push('resolve'), { ok: true, found: { kind: 'community', actor } }),
    ...change,
  };
  return { deps, calls };
}

describe('the steps of a resolve, cheapest first', () => {
  test('a visitor, an unverified account and text that is no lookup are refused before anything else is asked', async () => {
    const { deps, calls } = world();
    expect(await resolveForm(null, '!lab@lemmy.test', deps)).toEqual({ ok: false, error: 'auth.required' });
    expect(await resolveForm({ ...who, emailVerified: false }, '!lab@lemmy.test', deps)).toEqual({
      ok: false,
      error: 'auth.email_unverified',
    });
    expect(await resolveForm(who, 'not a lookup', deps)).toEqual({ ok: false, error: 'input.invalid' });
    expect(await resolveForm(who, '', deps)).toEqual({ ok: false, error: 'input.invalid' });
    expect(calls).toEqual([]);
  });

  test('what is already held redirects with no count and no fetch, even while resolving is paused or the host is blocked', async () => {
    const held: Held = { kind: 'community', actor };
    const { deps, calls } = world({ held: async () => held, enabled: async () => false, blocked: async () => true });
    expect(await resolveForm(who, '!lab@lemmy.test', deps)).toEqual({ ok: true, redirect: '/c/lab@lemmy.test' });
    expect(calls).toEqual([]);
  });

  test('an address of this server’s own that matches nothing is not found, with no count and no fetch', async () => {
    const { deps, calls } = world({ here: async () => true });
    expect(await resolveForm(who, 'https://disc.test/c/nothing', deps)).toEqual({ ok: false, error: 'target.not_found' });
    expect(calls).toEqual(['held']);
  });

  test('paused, blocked, then the budget, then the lookup, in that order, each stopping the rest', async () => {
    const paused = world({ enabled: async () => false });
    expect(await resolveForm(who, '!lab@lemmy.test', paused.deps)).toEqual({ ok: false, error: 'resolve.paused' });
    expect(paused.calls).toEqual(['held', 'here']);

    const blocked = world({ blocked: async (host) => (blockedCalls.push(host), true) });
    const blockedCalls: string[] = [];
    expect(await resolveForm(who, 'https://Blocked.test:8443/c/lab', blocked.deps)).toEqual({ ok: false, error: 'instance.blocked' });
    expect(blockedCalls).toEqual(['blocked.test:8443']);
    expect(blocked.calls).not.toContain('count');

    const full = world({}, { allowed: 0 });
    expect(await resolveForm(who, '!lab@lemmy.test', full.deps)).toEqual({ ok: false, error: 'rate.limited' });
    expect(full.calls).toEqual(['held', 'here', 'enabled', 'blocked lemmy.test', 'count']);

    const ok = world();
    expect(await resolveForm(who, '!lab@lemmy.test', ok.deps)).toEqual({ ok: true, redirect: '/c/lab@lemmy.test' });
    expect(ok.calls).toEqual(['held', 'here', 'enabled', 'blocked lemmy.test', 'count', 'resolve']);
  });

  test('the next networked lookup past the account budget is rate.limited and makes no fetch', async () => {
    const budget = budgets.resolve.id!.max;
    let fetched = 0;
    const { deps } = world({ resolve: async () => (fetched++, { ok: true, found: { kind: 'community', actor } }) }, { allowed: budget });
    for (let n = 0; n < budget; n += 1) expect(await resolveForm(who, '!lab@lemmy.test', deps)).toMatchObject({ ok: true });
    expect(await resolveForm(who, '!lab@lemmy.test', deps)).toEqual({ ok: false, error: 'rate.limited' });
    expect(fetched).toBe(budget);
    expect(budget).toBe(10);
  });

  test('a failed lookup answers with its code', async () => {
    const { deps } = world({ resolve: async () => ({ ok: false, error: 'peer.unreachable' }) });
    expect(await resolveForm(who, '!lab@lemmy.test', deps)).toEqual({ ok: false, error: 'peer.unreachable' });
  });
});

test('each kind of thing found goes to its local page', () => {
  expect(pageOf({ kind: 'community', actor })).toBe('/c/lab@lemmy.test');
  expect(pageOf({ kind: 'person', actor: { ...actor, kind: 'Person', handle: 'mira@lemmy.test' } })).toBe('/u/mira@lemmy.test');
  expect(pageOf({ kind: 'post', postId })).toBe(`/post/${postId}`);
  expect(pageOf({ kind: 'comment', postId, commentId })).toBe(`/post/${postId}/comments/${commentId}`);
});

describe('the answer', () => {
  const form = () => new Request('https://disc.test/resolve', { method: 'POST' });
  const json = () => new Request('https://disc.test/resolve', { method: 'POST', headers: { accept: 'application/json' } });

  test('without JavaScript: 303 to the page, or back with the code and what was typed', () => {
    const found = answer(form(), [], { ok: true, redirect: '/c/lab@lemmy.test' }, '!lab@lemmy.test');
    expect([found.status, found.headers.get('location')]).toEqual([303, '/c/lab@lemmy.test']);
    const missed = answer(form(), ['a=b'], { ok: false, error: 'target.not_found' }, '!x@lemmy.test');
    expect([missed.status, missed.headers.get('location'), missed.headers.get('set-cookie')]).toEqual([
      303,
      '/resolve?error=target.not_found&q=%21x%40lemmy.test',
      'a=b',
    ]);
    expect(answer(form(), [], { ok: false, error: 'input.invalid' }, '').headers.get('location')).toBe('/resolve?error=input.invalid');
  });

  test('hydrated: { redirect }, or { error } with 429 for rate.limited', async () => {
    const found = answer(json(), [], { ok: true, redirect: '/post/1' }, 'q');
    expect([found.status, await found.json()]).toEqual([200, { redirect: '/post/1' }]);
    const limited = answer(json(), [], { ok: false, error: 'rate.limited' }, 'q');
    expect([limited.status, await limited.json()]).toEqual([429, { error: 'rate.limited' }]);
    const missed = answer(json(), [], { ok: false, error: 'target.gone' }, 'q');
    expect([missed.status, await missed.json()]).toEqual([400, { error: 'target.gone' }]);
  });
});
