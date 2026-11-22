import type { Principal } from '@peblish/schema/authz';
import { beforeEach, expect, test, vi } from 'vitest';
import { handleInboxPost } from './-form.ts';

// The inbox form handler over a stand-in for the core mutations: notices held in memory, each
// with its owner, so every test can say which notices changed and for whom. The stand-in
// refuses a notice that is not the caller's, as core's authorize does.

const ann = '019a0000-0000-7000-8000-00000000000a';
const bob = '019a0000-0000-7000-8000-00000000000b';
const annFirst = '019a0000-0000-7000-8000-0000000000a1';
const annSecond = '019a0000-0000-7000-8000-0000000000a2';
const bobFirst = '019a0000-0000-7000-8000-0000000000b1';
const cursor = '019a0000-0000-7000-8000-0000000000c1';

const notices = vi.hoisted(() => new Map<string, { owner: string; read: boolean; batch?: string }>());
const watches = vi.hoisted(() => new Set<string>());
const batch = '1795000000000001';
const post = '019a0000-0000-7000-8000-0000000000d1';
const actorOf = (principal: Principal) => (principal.kind === 'anonymous' ? null : principal.actorId);

vi.mock('@peblish/core/notifications/service', () => ({
  markNotificationAs: async (principal: Principal, id: string, read: boolean) => {
    const notice = notices.get(id);
    if (!notice) return { ok: false, reason: 'target.not_found' };
    if (notice.owner !== actorOf(principal)) return { ok: false, reason: 'notification.not_yours' };
    const changed = notice.read !== read;
    notice.read = read;
    return { ok: true, changed };
  },
  markAllNotificationsReadAs: async (principal: Principal) => {
    let count = 0;
    for (const notice of notices.values())
      if (notice.owner === actorOf(principal) && !notice.read) {
        notice.read = true;
        notice.batch = batch;
        count += 1;
      }
    return { ok: true, count, batch: count > 0 ? batch : null };
  },
  undoMarkAllReadAs: async (principal: Principal, stamp: string) => {
    let count = 0;
    for (const notice of notices.values())
      if (notice.owner === actorOf(principal) && notice.read && notice.batch === stamp) {
        notice.read = false;
        delete notice.batch;
        count += 1;
      }
    return { ok: true, count };
  },
}));

// Thread follows: the post that exists is `post`; any other is not found.
vi.mock('@peblish/core/watches/watches', () => ({
  watchThreadAs: async (principal: Principal, { postId }: { postId: string }) => {
    if (postId !== post) return { ok: false, reason: 'target.not_found' };
    watches.add(`${actorOf(principal)}:${postId}`);
    return { ok: true, watching: true };
  },
  unwatchThreadAs: async (principal: Principal, { postId }: { postId: string }) => {
    watches.delete(`${actorOf(principal)}:${postId}`);
    return { ok: true, watching: false };
  },
}));

// The cookie `who=<actor id>` signs a request in; no cookie is signed out.
vi.mock('../../server/auth.ts', async (original) => ({
  ...(await original<typeof import('../../server/auth.ts')>()),
  formSession: async (request: Request) => {
    const who = /who=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1];
    return { session: who ? { view: { actorId: who, siteRole: 'user' }, setCookies: [] } : null };
  },
}));

beforeEach(() => {
  notices.clear();
  watches.clear();
  notices.set(annFirst, { owner: ann, read: false });
  notices.set(annSecond, { owner: ann, read: false });
  notices.set(bobFirst, { owner: bob, read: false });
});

/** Which notices are read now, by owner. */
const readNow = () =>
  Object.fromEntries([ann, bob].map((owner) => [owner, [...notices].filter(([, n]) => n.owner === owner && n.read).map(([id]) => id)]));

type Post = { as?: string; query?: Record<string, string>; body?: Record<string, string>; headers?: Record<string, string> };

function send({ as = ann, query = {}, body = {}, headers = {} }: Post) {
  const url = new URL('https://feddit.test/notifications');
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return handleInboxPost(
    new Request(url, {
      method: 'POST',
      body: new URLSearchParams(body),
      headers: {
        host: 'feddit.test',
        origin: 'https://feddit.test',
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `who=${as}`,
        ...headers,
      },
    }),
  );
}

const location = (response: Response) => [response.status, response.headers.get('location')];

test('the address alone carries a form: the notice it names is marked for the person signed in', async () => {
  expect(location(await send({ query: { intent: 'read', id: annFirst, filter: 'replies' } }))).toEqual([
    303,
    '/notifications?filter=replies',
  ]);
  expect(readNow()).toEqual({ [ann]: [annFirst], [bob]: [] });
});

test('a notice id in the body wins over the one in the address, both ways', async () => {
  await send({ query: { intent: 'read', id: annFirst }, body: { id: annSecond } });
  expect(readNow()).toEqual({ [ann]: [annSecond], [bob]: [] });

  notices.get(annSecond)!.read = false;
  await send({ query: { intent: 'read', id: annSecond }, body: { id: annFirst } });
  expect(readNow()).toEqual({ [ann]: [annFirst], [bob]: [] });
});

test("someone else's notice is refused whether it rides in the address or the body, and nothing changes", async () => {
  // Bob's id in the body over Ann's in the address: the body wins, so it is Bob's notice that is tried.
  expect(location(await send({ query: { intent: 'read', id: annFirst }, body: { id: bobFirst } }))).toEqual([
    303,
    '/notifications?error=notification.not_yours',
  ]);
  // Bob's id in the address under Ann's in the body: Ann's own notice is marked, Bob's is untouched.
  expect(location(await send({ query: { intent: 'read', id: bobFirst }, body: { id: annSecond } }))).toEqual([303, '/notifications']);
  expect(readNow()).toEqual({ [ann]: [annSecond], [bob]: [] });
});

test('an intent in the body wins over the one in the address', async () => {
  notices.get(annFirst)!.read = true;
  await send({ query: { intent: 'read', id: annFirst }, body: { intent: 'unread' } });
  expect(readNow()).toEqual({ [ann]: [], [bob]: [] });

  // read_all in the address, one notice in the body: only that notice.
  await send({ query: { intent: 'read_all' }, body: { intent: 'read', id: annSecond } });
  expect(readNow()).toEqual({ [ann]: [annSecond], [bob]: [] });

  // One notice in the address, read_all in the body: every notice of the caller's, and none of Bob's.
  await send({ query: { intent: 'read', id: annSecond }, body: { intent: 'read_all' } });
  expect(readNow()).toEqual({ [ann]: [annFirst, annSecond], [bob]: [] });
});

test('an unknown intent, a missing id and an id that is not one are refused, and nothing changes', async () => {
  const json = { accept: 'application/json' };
  const answer = async (response: Response) => [response.status, await response.json()];
  expect(await answer(await send({ query: { intent: 'delete', id: annFirst }, headers: json }))).toEqual([400, { error: 'invalid' }]);
  expect(await answer(await send({ query: { intent: 'read' }, headers: json }))).toEqual([400, { error: 'invalid' }]);
  expect(await answer(await send({ query: { intent: 'read', id: annFirst }, body: { intent: 'nonsense' }, headers: json }))).toEqual([
    400,
    { error: 'invalid' },
  ]);
  expect(await answer(await send({ query: { intent: 'read', id: 'not-an-id' }, headers: json }))).toEqual([
    400,
    { error: 'target.not_found' },
  ]);
  // An empty id in the body blanks a good one in the address: it does not fall back to it.
  expect(await answer(await send({ query: { intent: 'read', id: annFirst }, body: { id: '' }, headers: json }))).toEqual([
    400,
    { error: 'target.not_found' },
  ]);
  expect(readNow()).toEqual({ [ann]: [], [bob]: [] });
});

test('a post from another site is refused even when its fields ride only in the address, and nothing changes', async () => {
  const query = { intent: 'read_all' };
  expect((await send({ query, headers: { origin: 'https://evil.test' } })).status).toBe(403);
  expect((await send({ query: { intent: 'read', id: annFirst }, headers: { origin: 'null' } })).status).toBe(403);
  const noOrigin = { origin: '', 'sec-fetch-site': 'cross-site' };
  expect((await send({ query, headers: noOrigin })).status).toBe(403);
  expect(readNow()).toEqual({ [ann]: [], [bob]: [] });
});

test('signed out, a form is refused and nothing changes', async () => {
  const signedOut = await handleInboxPost(
    new Request('https://feddit.test/notifications?intent=read_all', {
      method: 'POST',
      body: new URLSearchParams(),
      headers: { host: 'feddit.test', 'content-type': 'application/x-www-form-urlencoded' },
    }),
  );
  expect(location(signedOut)).toEqual([303, '/notifications?error=auth.required']);
  expect(readNow()).toEqual({ [ann]: [], [bob]: [] });
  // A refused Undo goes back with its status row, so it can be pressed again once signed in.
  const undo = await handleInboxPost(
    new Request(`https://feddit.test/notifications?intent=undo_read_all&batch=${batch}&marked=2&filter=replies`, {
      method: 'POST',
      body: new URLSearchParams(),
      headers: { host: 'feddit.test', 'content-type': 'application/x-www-form-urlencoded' },
    }),
  );
  expect(location(undo)).toEqual([303, `/notifications?filter=replies&error=auth.required&marked=2&batch=${batch}`]);
});

test('the answer always goes back under /notifications, keeping only a known filter and a cursor that is an id', async () => {
  expect(location(await send({ query: { intent: 'read', id: annFirst, filter: 'mentions', cursor } }))).toEqual([
    303,
    `/notifications?filter=mentions&cursor=${cursor}`,
  ]);
  // The body's page wins too.
  expect(location(await send({ query: { intent: 'read_all', filter: 'mentions' }, body: { filter: 'account' } }))).toEqual([
    303,
    `/notifications?filter=account&marked=1&batch=${batch}`,
  ]);
  for (const [filter, badCursor] of [
    ['//evil.test', '../../admin'],
    ['https://evil.test/', `${cursor}/../x`],
    ['all', '?next=//evil.test'],
  ] as const) {
    for (const where of ['query', 'body'] as const) {
      const fields = { filter, cursor: badCursor };
      const response = await send(
        where === 'query' ? { query: { intent: 'read_all', ...fields } } : { query: { intent: 'read_all' }, body: fields },
      );
      expect(location(response), `${filter} ${badCursor} in the ${where}`).toEqual([303, '/notifications']);
    }
  }
  // A refused form keeps the page too, and only under /notifications.
  const refused = await send({ query: { intent: 'bogus', filter: '//evil.test', cursor } });
  expect(location(refused)).toEqual([303, '/notifications?error=invalid']);
});

test('Mark all read answers its count and its Undo stamp, in the JSON and in the address; Undo answers how many came back', async () => {
  const json = { accept: 'application/json' };
  const answer = async (response: Response) => [response.status, await response.json()];
  expect(await answer(await send({ query: { intent: 'read_all' }, headers: json }))).toEqual([200, { ok: true, count: 2, batch }]);
  expect(readNow()).toEqual({ [ann]: [annFirst, annSecond], [bob]: [] });
  // Bob's own Undo with Ann's stamp reaches only Bob's notices.
  expect(await answer(await send({ as: bob, query: { intent: 'undo_read_all', batch }, headers: json }))).toEqual([
    200,
    { ok: true, count: 0 },
  ]);
  expect(location(await send({ query: { intent: 'undo_read_all', batch, filter: 'replies' } }))).toEqual([
    303,
    '/notifications?filter=replies&restored=2',
  ]);
  expect(readNow()).toEqual({ [ann]: [], [bob]: [] });
  // Without scripts an Undo that finds nothing left answers that none came back.
  expect(location(await send({ query: { intent: 'undo_read_all', batch, marked: '2' } }))).toEqual([303, '/notifications?restored=0']);
  // Without scripts the answer is the page with the status row's fields.
  expect(location(await send({ query: { intent: 'read_all', filter: 'replies' } }))).toEqual([
    303,
    `/notifications?filter=replies&marked=2&batch=${batch}`,
  ]);
  // Nothing unread: no stamp, so nothing to undo.
  expect(location(await send({ query: { intent: 'read_all' } }))).toEqual([303, '/notifications']);
  // A stamp that is not one is refused before core is asked.
  expect(await answer(await send({ query: { intent: 'undo_read_all', batch: '1 or true' }, headers: json }))).toEqual([
    400,
    { error: 'invalid' },
  ]);
  expect(await answer(await send({ query: { intent: 'undo_read_all' }, headers: json }))).toEqual([400, { error: 'invalid' }]);
});

test('Follow thread and Unfollow post here and answer back to the post, never anywhere else', async () => {
  const json = { accept: 'application/json' };
  expect(location(await send({ query: { intent: 'watch', post } }))).toEqual([303, `/post/${post}`]);
  expect(watches).toEqual(new Set([`${ann}:${post}`]));
  expect(await (await send({ query: { intent: 'unwatch', post }, headers: json })).json()).toEqual({ ok: true, watching: false });
  expect(watches).toEqual(new Set());
  // A refusal goes back to the post with its reason; an id that is not one, and a missing one, stay under /notifications.
  const missing = '019a0000-0000-7000-8000-0000000000d2';
  expect(location(await send({ query: { intent: 'watch', post: missing } }))).toEqual([303, `/post/${missing}?error=target.not_found`]);
  expect(location(await send({ query: { intent: 'watch', post: '//evil.test' } }))).toEqual([303, '/notifications?error=target.not_found']);
  expect(location(await send({ query: { intent: 'watch' } }))).toEqual([303, '/notifications?error=invalid']);
  // The inbox page fields are ignored for a thread: the answer is the post.
  expect(location(await send({ query: { intent: 'watch', post, filter: 'replies' } }))).toEqual([303, `/post/${post}`]);
  expect(location(await send({ as: '', query: { intent: 'watch', post } }))).toEqual([303, '/notifications?error=auth.required']);
});
