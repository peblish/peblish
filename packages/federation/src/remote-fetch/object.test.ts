import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { db } from '@peblish/core/db/read';
import { comments, posts, votes } from '@peblish/core/db/tables/content';
import { deletionLedger } from '@peblish/core/db/tables/site';
import { truncateAll } from '@peblish/core/testing/db';
import { nodeInfoRoutes, stubFetch } from '@peblish/core/testing/seed-fed-a';
import { deliverRow, inboxState, seedInboundWorld } from '@peblish/core/testing/seed-fed-b';
import { processPending } from '../inbound/job.ts';
import { processRow } from '../inbound/pipeline.ts';
import { resetKeyFetchBudget } from '../inbound/throttle.ts';
import { activityId } from '../inbound/test-support.ts';
import { fetchRemoteObject, maxParentDepth, type Vouch } from './object.ts';
import { announceOf, lab, lemmy, lemmyNote, lemmyPage, lemmyuser } from './test-support.ts';

let world: Awaited<ReturnType<typeof seedInboundWorld>>;
let vouch: Vouch;
beforeEach(async () => {
  await truncateAll();
  resetKeyFetchBudget();
  world = await seedInboundWorld();
  vouch = { community: { id: world.peers.lab.id, apId: lab }, announceApId: `${lemmy}/activities/announce/1` };
});

const serving = (routes: Record<string, unknown>) =>
  stubFetch({
    ...Object.fromEntries(Object.entries(routes).map(([url, body]) => [url, { body }])),
    ...nodeInfoRoutes('lemmy.test', 'lemmy'),
  });
const storedPost = async (apId: string) => (await db().select().from(posts).where(eq(posts.apId, apId)))[0];
const ledger = () => db().select().from(deletionLedger);

describe('fetching a post on demand', () => {
  test('stores a Lemmy Page from its own origin as its author, in the community that vouches for it', async () => {
    const page = lemmyPage(300);
    const peer = serving({ [`${lemmy}/post/300`]: page });
    expect(await fetchRemoteObject(`${lemmy}/post/300`, { vouch, fetch: peer.fetch })).toEqual({
      status: 'stored',
      kind: 'post',
      apId: `${lemmy}/post/300`,
      created: true,
    });
    expect(await storedPost(`${lemmy}/post/300`)).toMatchObject({
      title: 'Post 300',
      authorId: world.peers.lemmyuser.id,
      communityId: world.peers.lab.id,
      local: false,
    });
    // One GET of the object's own URL, asking for ActivityPub JSON.
    const gets = peer.requests.filter((request) => request.url === `${lemmy}/post/300`);
    expect(gets).toHaveLength(1);
    expect(gets[0]?.headers.get('accept')).toContain('activity+json');
    // Fetched again, it is the same post.
    expect(await fetchRemoteObject(`${lemmy}/post/300`, { vouch, fetch: peer.fetch })).toMatchObject({ status: 'stored', created: false });
  });

  test('applies the vote that was waiting for it, once', async () => {
    const target = `${lemmy}/post/301`;
    const dislike = { id: activityId(lemmy, 'dislike'), type: 'Dislike', actor: lemmyuser, object: target, audience: lab };
    const waiting = await deliverRow(announceOf(lab, activityId(lemmy, 'announce'), dislike), (row) => processRow(row));
    expect(waiting.stored).toEqual({ state: 'skipped', error: `target.missing ${target}` });

    await fetchRemoteObject(target, { vouch, fetch: serving({ [target]: lemmyPage(301) }).fetch });
    expect((await inboxState(waiting.row.id))?.state).toBe('pending');
    await processPending();
    expect(await inboxState(waiting.row.id)).toEqual({ state: 'applied', error: null });
    expect(await db().select().from(votes).where(eq(votes.value, -1))).toHaveLength(1);
  });

  test('refuses what the inbound rules refuse: another community, sensitive content, an object not on its author’s origin', async () => {
    const check = async (page: Record<string, unknown>) =>
      fetchRemoteObject(String(page.id), { vouch, fetch: serving({ [String(page.id)]: page }).fetch });
    expect(await check(lemmyPage(310, { audience: `${lemmy}/c/other`, to: [`${lemmy}/c/other`] }))).toMatchObject({
      status: 'refused',
      reason: 'community.mismatch',
    });
    expect(await check(lemmyPage(311, { sensitive: true }))).toMatchObject({ status: 'refused', reason: 'content.nsfw_rejected' });
    expect(await check(lemmyPage(312, { attributedTo: 'https://rogue.test/u/mallory' }))).toMatchObject({
      status: 'refused',
      reason: 'object.origin_mismatch',
    });
    expect(await db().select().from(posts).where(eq(posts.communityId, world.peers.lab.id))).toHaveLength(1); // the world's own t2
  });

  test('says what went wrong with the peer: down, or not there', async () => {
    const target = `${lemmy}/post/320`;
    expect(await fetchRemoteObject(target, { vouch, fetch: stubFetch({ [target]: { status: 503 } }).fetch })).toMatchObject({
      status: 'unreachable',
    });
    expect(await fetchRemoteObject(target, { vouch, fetch: stubFetch({}).fetch })).toEqual({
      status: 'refused',
      apId: target,
      reason: 'object.not_found',
    });
    // Nobody vouches for an object we do not hold.
    expect(await fetchRemoteObject(target, { fetch: stubFetch({}).fetch })).toEqual({
      status: 'refused',
      apId: target,
      reason: 'object.unvouched',
    });
  });
});

describe('a comment fetched on demand', () => {
  test('is stored under its post, and a parent we do not hold is fetched first', async () => {
    const post = lemmyPage(330);
    const parent = lemmyNote(1, `${lemmy}/post/330`);
    const child = lemmyNote(2, `${lemmy}/comment/1`);
    const peer = serving({ [`${lemmy}/post/330`]: post, [`${lemmy}/comment/1`]: parent, [`${lemmy}/comment/2`]: child });
    expect(await fetchRemoteObject(`${lemmy}/comment/2`, { vouch, fetch: peer.fetch })).toMatchObject({
      status: 'stored',
      kind: 'comment',
      created: true,
    });
    expect((await db().select().from(comments)).map((row) => row.apId).sort()).toEqual([`${lemmy}/comment/1`, `${lemmy}/comment/2`]);
    const [replyRow] = await db()
      .select()
      .from(comments)
      .where(eq(comments.apId, `${lemmy}/comment/2`));
    const [parentRow] = await db()
      .select()
      .from(comments)
      .where(eq(comments.apId, `${lemmy}/comment/1`));
    expect(replyRow?.path.startsWith(`${parentRow!.path}.`)).toBe(true);
  });

  test('is refused when its ancestors run past the depth we will walk, or live in another community', async () => {
    const chain = Array.from({ length: maxParentDepth + 2 }, (_, i) =>
      lemmyNote(i + 1, i === 0 ? `${lemmy}/post/340` : `${lemmy}/comment/${i}`),
    );
    const routes = Object.fromEntries([[`${lemmy}/post/340`, lemmyPage(340)], ...chain.map((note) => [String(note.id), note])]);
    const peer = serving(routes);
    const last = String(chain.at(-1)!.id);
    expect(await fetchRemoteObject(last, { vouch, fetch: peer.fetch })).toEqual({
      status: 'refused',
      apId: last,
      reason: 'parent.missing',
    });

    // t1 is a post in the local community: a lab Announce cannot vouch for a comment on it.
    const stray = lemmyNote(50, world.t1.apId);
    expect(await fetchRemoteObject(String(stray.id), { vouch, fetch: serving({ [String(stray.id)]: stray }).fetch })).toMatchObject({
      status: 'refused',
      reason: 'mod.announce_mismatch',
    });
  });
});

describe('this server’s own ids', () => {
  test('are never fetched: a comment replying to one of ours that we do not hold is refused with no request', async () => {
    const own = `${new URL(world.community.apId).origin}/ap/post/does-not-exist`;
    const note = lemmyNote(60, own);
    const peer = serving({ [String(note.id)]: note, [own]: lemmyPage(61) });
    expect(await fetchRemoteObject(String(note.id), { vouch, fetch: peer.fetch })).toEqual({
      status: 'refused',
      apId: String(note.id),
      reason: 'parent.missing',
    });
    expect(peer.requests.some((request) => request.url === own)).toBe(false);
    expect(await fetchRemoteObject(own, { vouch, fetch: peer.fetch })).toEqual({ status: 'refused', apId: own, reason: 'object.local' });
    expect(peer.requests.some((request) => request.url === own)).toBe(false);
  });
});

describe('an object its server answers with 410 or a Tombstone', () => {
  test('is soft-deleted in our copy and recorded in the ledger, once', async () => {
    const target = `${lemmy}/post/350`;
    await fetchRemoteObject(target, { vouch, fetch: serving({ [target]: lemmyPage(350) }).fetch });
    const gone = stubFetch({ [target]: { status: 410, body: { type: 'Tombstone', id: target } } });
    // No vouch needed: the stored copy says which community it is in.
    expect(await fetchRemoteObject(target, { fetch: gone.fetch })).toEqual({ status: 'gone', apId: target, deleted: true });
    expect((await storedPost(target))?.deletedAt).toBeInstanceOf(Date);
    expect(await ledger()).toMatchObject([{ subjectKind: 'post', subjectApId: target, reason: 'remote.object_gone' }]);

    expect(await fetchRemoteObject(target, { fetch: gone.fetch })).toEqual({ status: 'gone', apId: target, deleted: false });
    expect(await ledger()).toHaveLength(1);
  });

  test('a Tombstone served with 200 is the same, for a comment; an object never held is just gone', async () => {
    const post = `${lemmy}/post/360`;
    const note = `${lemmy}/comment/360`;
    const peer = serving({ [post]: lemmyPage(360), [note]: lemmyNote(360, post) });
    await fetchRemoteObject(note, { vouch, fetch: peer.fetch });
    const tombstone = serving({ [note]: { type: 'Tombstone', id: note, formerType: 'Note' } });
    expect(await fetchRemoteObject(note, { fetch: tombstone.fetch })).toEqual({ status: 'gone', apId: note, deleted: true });
    expect((await db().select().from(comments).where(eq(comments.apId, note)))[0]?.deletedAt).toBeInstanceOf(Date);
    expect(await ledger()).toMatchObject([{ subjectKind: 'comment', subjectApId: note }]);

    const unknown = `${lemmy}/post/361`;
    expect(await fetchRemoteObject(unknown, { vouch, fetch: stubFetch({ [unknown]: { status: 410 } }).fetch })).toEqual({
      status: 'gone',
      apId: unknown,
      deleted: false,
    });
  });
});

describe('a document served under another id', () => {
  const alice = 'https://good.test/u/alice';
  const foreign = (extra: Record<string, unknown> = {}) =>
    lemmyPage(1, { id: 'https://good.test/post/1', attributedTo: alice, audience: lab, ...extra });

  test('is refused: another host’s post cannot be stored from this host’s URL, as that host’s author', async () => {
    const asked = `${lemmy}/post/370`;
    const peer = serving({ [asked]: foreign() });
    expect(await fetchRemoteObject(asked, { vouch, fetch: peer.fetch })).toEqual({
      status: 'refused',
      apId: asked,
      reason: 'object.id_mismatch',
    });
    expect(await storedPost('https://good.test/post/1')).toBeUndefined();
    // Nothing was fetched on behalf of the claimed author.
    expect(peer.requests.map((request) => request.url)).toEqual([asked]);
  });

  test('is refused on the same host too, and when it names no id', async () => {
    const asked = `${lemmy}/post/371`;
    expect(await fetchRemoteObject(asked, { vouch, fetch: serving({ [asked]: lemmyPage(372) }).fetch })).toMatchObject({
      status: 'refused',
      reason: 'object.id_mismatch',
    });
    const { id: _id, ...anonymous } = lemmyPage(371);
    expect(await fetchRemoteObject(asked, { vouch, fetch: serving({ [asked]: anonymous }).fetch })).toMatchObject({
      status: 'refused',
      reason: 'object.id_mismatch',
    });
  });

  test('is refused when it was served from another origin than its id, and a Tombstone of another id deletes nothing', async () => {
    const asked = `${lemmy}/post/373`;
    const peer = serving({ [asked]: lemmyPage(373) });
    // The fetch ended on another server (a redirect): the document there cannot speak for this id.
    const redirected: typeof peer.fetch = async (url, init) => ({
      ...(await peer.fetch(url, init)),
      url: 'https://elsewhere.test/post/373',
    });
    expect(await fetchRemoteObject(asked, { vouch, fetch: redirected })).toMatchObject({ status: 'refused', reason: 'object.id_mismatch' });

    await fetchRemoteObject(asked, { vouch, fetch: peer.fetch });
    const wrong = serving({ [asked]: { type: 'Tombstone', id: `${lemmy}/post/999` } });
    expect(await fetchRemoteObject(asked, { fetch: wrong.fetch })).toMatchObject({ status: 'refused', reason: 'object.id_mismatch' });
    expect((await storedPost(asked))?.deletedAt).toBeNull();
    expect(await ledger()).toEqual([]);
  });
});
