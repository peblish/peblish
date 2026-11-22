import type { CurrentSession } from '@peblish/core/identity/session';
import { beforeEach, expect, test, vi } from 'vitest';
import { hostileReturns } from '../../../server/__fixtures__/return-addresses.ts';
import { queueHref } from './-href.ts';

// The queue's form posts and their way back (`back`): a queue address, serialised so it can be a
// Location, or the queue itself. The session and the core calls are stubbed.

const origin = 'https://feddit.test';
const target = 'post:019a0000-0000-7000-8000-000000000001';

const actions = vi.hoisted(() => ({ resolveReportsAs: vi.fn(), removeFromReportAs: vi.fn(), routeReportsAs: vi.fn() }));
vi.mock('@peblish/core/reports/actions', () => actions);
const signedIn = vi.hoisted(() => ({ session: null as CurrentSession | null }));
vi.mock('../../../server/auth.ts', async (original) => {
  const real = await original<typeof import('../../../server/auth.ts')>();
  return { ...real, formSession: async (request: Request) => real.withSession(request, signedIn.session) };
});
const { Route } = await import('./index.tsx');

beforeEach(() => {
  signedIn.session = {
    view: {
      userId: '019a0000-0000-7000-8000-0000000000a1',
      actorId: '019a0000-0000-7000-8000-0000000000a2',
      name: 'mira',
      displayName: null,
      siteRole: 'user',
      emailVerified: true,
      twoFactorEnabled: false,
      ageDeclaredAt: null,
    },
    sessionId: '019a0000-0000-7000-8000-0000000000a3',
    email: 'mira@example.test',
    role: 'user',
    sessionCreatedAt: new Date(),
    setCookies: [],
  };
  for (const action of Object.values(actions)) action.mockReset().mockResolvedValue({ ok: true });
});

type Handler = (context: { request: Request }) => Promise<Response>;
function post(fields: Record<string, string>, json = false): Promise<Response> {
  const handlers = Route.options.server?.handlers;
  const handler = typeof handlers === 'object' && handlers && 'POST' in handlers ? handlers.POST : undefined;
  if (typeof handler !== 'function') throw new Error('the queue has no POST handler');
  const headers = new Headers({ host: 'feddit.test', origin });
  if (json) headers.set('accept', 'application/json');
  const request = new Request(`${origin}/admin/reports`, { method: 'POST', headers, body: new URLSearchParams(fields) });
  return (handler as Handler)({ request });
}
const resolve = (back: string, json = false) => post({ intent: 'resolve', target, audience: 'moderators', back }, json);
const where = (response: Response) => [response.status, response.headers.get('location')];

test('a way back with characters a header cannot carry: the action is done and the queue answers 303, encoded', async () => {
  const back = '/admin/reports?community=料理&sort=oldest';
  const encoded = '/admin/reports?community=%E6%96%99%E7%90%86&sort=oldest';
  expect(where(await resolve(back))).toEqual([303, encoded]);
  expect(actions.resolveReportsAs).toHaveBeenCalledTimes(1);
  expect(await (await resolve(back, true)).json()).toEqual({ redirect: encoded });
});

test("the queue's own addresses come back as they are", async () => {
  const view = { tab: 'escalated', community: 'news', sort: 'newest', cursor: 'abc', show: target } as const;
  for (const back of [queueHref(view), queueHref({ tab: 'open', community: null, sort: 'oldest' }), '/admin/reports']) {
    expect(where(await resolve(back))).toEqual([303, back]);
  }
});

test('an address outside the queue goes to the queue itself', async () => {
  for (const back of [
    '/admin/bans?modFor=x',
    '/admin/reportsx?tab=open',
    '/admin/reports/../bans?tab=open',
    '/',
    ...hostileReturns.map(([, address]) => address),
  ]) {
    expect([back, ...where(await resolve(back))]).toEqual([back, 303, '/admin/reports']);
  }
});
