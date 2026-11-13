import { eq } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { actors } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import { writer } from '../db/write.ts';
import type { MediaContent } from '../media/proxy-url.ts';
import { contentShown } from '../media/reference.ts';
import { truncateAll } from '../testing/db.ts';
import { seedCommunityRemoval, seedComment, seedPost } from '../testing/seed-az.ts';
import { declareAge, seedAccount } from '../testing/seed-b1.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { mediaBlocklist } from '../mediascan/tables.ts';
import { peerControls } from '../peers/tables.ts';
import { remoteMedia } from '../testing/seed-safe.ts';
import { publicAnswerTags, publicTags } from './public.ts';
import { edgeStatus } from './tables.ts';
import { hashTag, hostTag } from './tags.ts';

beforeEach(truncateAll);

async function world() {
  const local = await seedInstance('feddit.test');
  const author = await seedAccount(local, 'author');
  const replier = await seedAccount(local, 'replier');
  await declareAge(replier);
  const community = await seedActor(local, 'Group', 'pics');
  const post = await seedPost(local, community, author);
  const comment = await seedComment(local, post, replier);
  const items: Pick<MediaContent, 'kind' | 'id'>[] = [
    { kind: 'post', id: post.id },
    { kind: 'comment', id: comment.id },
    { kind: 'actor', id: author.id },
    { kind: 'actor', id: community.id },
  ];
  return { local, author, replier, community, post, comment, items };
}

/** Public exactly when the proxy would show it to a signed-out visitor, item by item. */
async function expectPublicIsSignedOut(items: Pick<MediaContent, 'kind' | 'id'>[], expected: boolean[]) {
  const tags = await Promise.all(items.map((item) => publicTags(item)));
  const shown = await Promise.all(items.map((item) => contentShown(item, null)));
  expect(tags.map((t) => t !== null)).toEqual(expected);
  expect(shown).toEqual(expected);
}

test('public content carries the wide tag, its own, and the tags of everything its visibility rests on', async () => {
  const w = await world();
  const [post, comment, person, community] = await Promise.all(w.items.map((item) => publicTags(item)));
  expect(post).toEqual(['pbm', `pbm-p-${w.post.id}`, `pbm-a-${w.community.id}`, `pbm-a-${w.author.id}`]);
  expect(comment).toEqual([
    'pbm',
    `pbm-c-${w.comment.id}`,
    `pbm-p-${w.post.id}`,
    `pbm-a-${w.community.id}`,
    `pbm-a-${w.author.id}`,
    `pbm-a-${w.replier.id}`,
  ]);
  expect(person).toEqual(['pbm', `pbm-a-${w.author.id}`]);
  expect(community).toEqual(['pbm', `pbm-a-${w.community.id}`]);
});

test('content gated, removed or deleted for a signed-out visitor is never public, whoever else may see it', async () => {
  const w = await world();
  await expectPublicIsSignedOut(w.items, [true, true, true, true]);

  // A sensitive post: a declared viewer may open it, a visitor may not.
  await writer().update(posts).set({ sensitive: true }).where(eq(posts.id, w.post.id));
  await expectPublicIsSignedOut(w.items, [false, false, true, true]);
  await writer().update(posts).set({ sensitive: false }).where(eq(posts.id, w.post.id));

  // A removed comment, then a deleted one (moderators still see removed content: never public).
  await writer().update(comments).set({ removedAt: new Date() }).where(eq(comments.id, w.comment.id));
  await expectPublicIsSignedOut(w.items, [true, false, true, true]);
  await writer().update(comments).set({ removedAt: null, deletedAt: new Date() }).where(eq(comments.id, w.comment.id));
  await expectPublicIsSignedOut(w.items, [true, false, true, true]);
  await writer().update(comments).set({ deletedAt: null }).where(eq(comments.id, w.comment.id));

  // A removed post takes its comments; a deleted one is a tombstone whose comments stay.
  await writer().update(posts).set({ removedAt: new Date() }).where(eq(posts.id, w.post.id));
  await expectPublicIsSignedOut(w.items, [false, false, true, true]);
  await writer().update(posts).set({ removedAt: null, deletedAt: new Date() }).where(eq(posts.id, w.post.id));
  await expectPublicIsSignedOut(w.items, [false, true, true, true]);
  await writer().update(posts).set({ deletedAt: null }).where(eq(posts.id, w.post.id));

  // A sensitive community, then a deleted person, then a removed community.
  await writer().update(actors).set({ sensitive: true }).where(eq(actors.id, w.community.id));
  await expectPublicIsSignedOut(w.items, [false, false, true, false]);
  await writer().update(actors).set({ sensitive: false }).where(eq(actors.id, w.community.id));
  await writer().update(actors).set({ deletedAt: new Date() }).where(eq(actors.id, w.author.id));
  await expectPublicIsSignedOut(w.items, [true, true, false, true]);
  await seedCommunityRemoval(w.community);
  await expectPublicIsSignedOut(w.items, [false, false, false, false]);
});

test('an unknown id is not public', async () => {
  await world();
  const missing = '0195f0a0-0000-7000-8000-000000000000';
  for (const kind of ['post', 'comment', 'actor'] as const) expect(await publicTags({ kind, id: missing }), kind).toBeNull();
});

const sha256 = 'ab'.repeat(32);

/** The purge path proven just now (send.ts writes this after a successful request). */
const proven = () => writer().insert(edgeStatus).values({ name: 'cloudflare', verifiedAt: new Date() });

test('a public answer needs every fact true in one read after the fetch: ready, switch on, supplier, every host, hash, content (item 1)', async () => {
  const w = await world();
  const peer = await seedInstance('lemmy.test', false);
  await writer().insert(peerControls).values({ instanceId: peer.id, media: 'approved' });
  const check = {
    content: { kind: 'post' as const, id: w.post.id, supplier: 'lemmy.test' },
    hosts: ['img.example', 'cdn.lemmy.test'],
    sha256,
  };
  // Not ready: no record of a working purge path.
  expect(await publicAnswerTags(check)).toBeNull();
  await proven();
  const tags = await publicAnswerTags(check);
  expect(tags).toEqual(
    expect.arrayContaining([
      'pbm',
      `pbm-p-${w.post.id}`,
      hostTag('lemmy.test'),
      hostTag('test'),
      hostTag('img.example'),
      hostTag('cdn.lemmy.test'),
      hashTag(sha256),
    ]),
  );
  expect(new Set(tags).size).toBe(tags?.length);

  // A redirect host that is quarantined (a known peer without approval).
  await seedInstance('other.test', false);
  expect(await publicAnswerTags({ ...check, hosts: [...check.hosts, 'img.other.test'] })).toBeNull();
  // The supplier no longer approved.
  await writer().update(peerControls).set({ media: 'quarantined' }).where(eq(peerControls.instanceId, peer.id));
  expect(await publicAnswerTags(check)).toBeNull();
  await writer().update(peerControls).set({ media: 'approved' }).where(eq(peerControls.instanceId, peer.id));
  // The hash on the blocked-image list.
  await writer().insert(mediaBlocklist).values({ kind: 'sha256', value: sha256, category: 'other' });
  expect(await publicAnswerTags(check)).toBeNull();
  await writer().delete(mediaBlocklist);
  // The kill switch off.
  await remoteMedia(false);
  expect(await publicAnswerTags(check)).toBeNull();
  await remoteMedia(true);
  // The content no longer public.
  await writer().update(posts).set({ sensitive: true }).where(eq(posts.id, w.post.id));
  expect(await publicAnswerTags(check)).toBeNull();
  await writer().update(posts).set({ sensitive: false }).where(eq(posts.id, w.post.id));
  expect(await publicAnswerTags(check)).not.toBeNull();
});

test('a read that took longer than the deadline gives a private answer, however it came out (item 1)', async () => {
  const w = await world();
  await proven();
  const check = { content: { kind: 'post' as const, id: w.post.id, supplier: null }, hosts: ['img.example'], sha256 };
  let at = 0;
  const clock = () => (at += 1_000);
  // Two readings 1 s apart: within a 2 s deadline, not within a 0.5 s one.
  expect(await publicAnswerTags(check, { clock, deadlineMs: 2_000 })).not.toBeNull();
  expect(await publicAnswerTags(check, { clock, deadlineMs: 500 })).toBeNull();
});
