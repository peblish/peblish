import { expect, test } from 'vitest';
import { answer, backWithError } from './-answer.ts';

const form = () => new Request('https://disc.test/communities/follow', { method: 'POST' });
const json = () => new Request('https://disc.test/communities/follow', { method: 'POST', headers: { accept: 'application/json' } });

test('without JavaScript a join goes back to the page, and a refusal goes back with its reason, keeping the page’s own query', async () => {
  const done = answer(form(), [], { ok: true }, '/communities?sort=active&q=tech');
  expect([done.status, done.headers.get('location')]).toEqual([303, '/communities?sort=active&q=tech']);
  const refused = answer(form(), ['a=b'], { ok: false, reason: 'community.banned' }, '/communities?sort=active&error=old');
  expect([refused.status, refused.headers.get('location'), refused.headers.get('set-cookie')]).toEqual([
    303,
    '/communities?sort=active&error=community.banned',
    'a=b',
  ]);
  expect(backWithError('/communities', 'auth.required')).toBe('/communities?error=auth.required');
});

test('a hydrated form gets JSON', async () => {
  const done = answer(json(), [], { ok: true }, '/communities');
  expect([done.status, await done.json()]).toEqual([200, { ok: true }]);
  const refused = answer(json(), [], { ok: false, reason: 'community.removed' }, '/communities');
  expect([refused.status, await refused.json()]).toEqual([400, { error: 'community.removed' }]);
});
