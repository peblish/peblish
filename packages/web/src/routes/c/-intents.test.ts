import { beforeEach, expect, test, vi } from 'vitest';
import { AGE_GATE_COOKIE } from '../../server/auth.ts';
import { communityPost } from './-intents.ts';

// The handler's own logic, with its session, lookups and the core mutation stubbed.
const declareAgeAs = vi.hoisted(() => vi.fn());
vi.mock('@peblish/core/communities/age', () => ({ declareAgeAs }));
vi.mock('@peblish/core/communities/read', () => ({ findCommunityId: async () => '019a0000-0000-7000-8000-000000000001' }));
vi.mock('@peblish/core/identity/handles', () => ({ localHandles: async () => ({ origin: 'https://feddit.test' }) }));
vi.mock('../../server/auth.ts', async (original) => ({
  ...(await original<typeof import('../../server/auth.ts')>()),
  formSession: async () => ({ session: { view: { actorId: '019a0000-0000-7000-8000-000000000002', siteRole: 'user' }, setCookies: [] } }),
  ageGateCookie: async () => `${AGE_GATE_COOKIE}=1; Path=/`,
}));

beforeEach(() => {
  declareAgeAs.mockReset();
  declareAgeAs.mockResolvedValue({ ok: false, reason: 'age.under_16' });
});

const declare = (cookie?: string) => {
  const body = new URLSearchParams({ intent: 'declare', day: '1', month: '1', year: '2015', redirect: '/c/adults' });
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded', host: 'feddit.test' });
  if (cookie) headers.set('cookie', cookie);
  return communityPost(new Request('https://feddit.test/c/adults', { method: 'POST', body, headers }), 'adults');
};

test('an under-16 answer sets the 24 hour cookie, and a browser that has it may not declare again', async () => {
  const first = await declare();
  expect([first.status, first.headers.get('location'), first.headers.get('set-cookie')]).toEqual([
    303,
    '/c/adults',
    `${AGE_GATE_COOKIE}=1; Path=/`,
  ]);
  expect(declareAgeAs).toHaveBeenCalledTimes(1);

  declareAgeAs.mockResolvedValue({ ok: true, created: true });
  const retry = await declare(`${AGE_GATE_COOKIE}=1`);
  expect([retry.status, retry.headers.get('location'), retry.headers.get('set-cookie')]).toEqual([303, '/c/adults', null]);
  expect(declareAgeAs).toHaveBeenCalledTimes(1);
});
