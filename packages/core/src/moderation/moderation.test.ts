import type { ContentRef } from '@peblish/schema/ids';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { db } from '../db/read.ts';
import { comments, posts } from '../db/tables/content.ts';
import { readModlog } from '../modlog/read.ts';
import { truncateAll } from '../testing/db.ts';
import { grantFor, outboxEvents, seedBan, seedComment, seedModerator, seedPost, writeCounts } from '../testing/seed-az.ts';
import { localUser, seedActor, seedInstance } from '../testing/seed.ts';
import { Refused } from '../tx/refused.ts';
import { banFromCommunity, unbanFromCommunity } from './ban.ts';
import { lockPost, unlockPost } from './lock.ts';
import { pinPost, unpinPost } from './pin.ts';
import { removeContent, restoreContent } from './remove.ts';
import { communityBans } from './tables.ts';

beforeEach(truncateAll);

async function setup() {
  const instance = await seedInstance('feddit.test');
  const moderator = await seedActor(instance, 'Person', 'moderator');
  const author = await seedActor(instance, 'Person', 'author');
  const community = await seedActor(instance, 'Group', 'announcements');
  await seedModerator(community, moderator);
  const post = await seedPost(instance, community, author);
  const comment = await seedComment(instance, post, author);
  return { instance, moderator, author, community, post, comment, mod: localUser(moderator.id) };
}

const postRow = async (id: string) => (await db().select().from(posts).where(eq(posts.id, id)))[0]!;
const commentRow = async (id: string) => (await db().select().from(comments).where(eq(comments.id, id)))[0]!;
const removedAt = (target: ContentRef) =>
  (target.kind === 'post' ? postRow(target.id) : commentRow(target.id)).then((row) => row.removedAt);

describe('remove and restore', () => {
  test.each(['post', 'comment'] as const)(
    'a %s round trip: the reason is logged, restore clears the removal, both entries stay',
    async (kind) => {
      const { moderator, community, post, comment, mod } = await setup();
      const target = { kind, id: kind === 'post' ? post.id : comment.id };
      const apId = kind === 'post' ? post.apId : comment.apId;
      const removed = await removeContent(await grantFor('mod.remove', mod, { target }), { reason: 'Rule 2: off topic' });
      expect(await removedAt(target)).toBeInstanceOf(Date);
      const restored = await restoreContent(await grantFor('mod.restore', mod, { target }), { reason: 'Appeal upheld' });
      expect(await removedAt(target)).toBeNull();

      const log = await readModlog({ communityId: community.id }, { audience: 'public' });
      expect(log.map(({ id, action, reason }) => ({ id, action, reason }))).toEqual([
        { id: restored.modlogId, action: 'mod.restore', reason: 'Appeal upheld' },
        { id: removed.modlogId, action: 'mod.remove', reason: 'Rule 2: off topic' },
      ]);
      expect(log[1]).toMatchObject({
        actorId: moderator.id,
        actorApId: moderator.apId,
        communityApId: community.apId,
        targetPostId: kind === 'post' ? post.id : null,
        targetCommentId: kind === 'comment' ? comment.id : null,
        targetApId: apId,
        authority: { kind: 'local-role', actorId: moderator.id, role: 'moderator', communityId: community.id },
      });
      const event = {
        type: 'mod.remove',
        v: 1,
        moderatorId: moderator.id,
        local: true,
        communityId: community.id,
        target,
        targetApId: apId,
      };
      expect(await outboxEvents()).toEqual([
        { ...event, modlogId: removed.modlogId, removed: true, reason: 'Rule 2: off topic' },
        { ...event, modlogId: restored.modlogId, removed: false, reason: 'Appeal upheld' },
      ]);
    },
  );
});

test('lock and pin set their flag, unlock and unpin clear it; each is logged and emitted', async () => {
  const { moderator, community, post, mod } = await setup();
  const subject = { postId: post.id };
  await lockPost(await grantFor('mod.lock', mod, subject), { reason: 'Heated' });
  await pinPost(await grantFor('mod.pin', mod, subject), {});
  expect(await postRow(post.id)).toMatchObject({ locked: true, featuredCommunity: true });
  await unlockPost(await grantFor('mod.unlock', mod, subject), {});
  await unpinPost(await grantFor('mod.unpin', mod, subject), {});
  expect(await postRow(post.id)).toMatchObject({ locked: false, featuredCommunity: false });

  const log = await readModlog({ communityId: community.id }, { audience: 'staff' });
  expect(log.map(({ action }) => action)).toEqual(['mod.unpin', 'mod.unlock', 'mod.pin', 'mod.lock']);
  const base = { v: 1, moderatorId: moderator.id, local: true, communityId: community.id, postId: post.id, targetApId: post.apId };
  expect(await outboxEvents()).toMatchObject([
    { ...base, type: 'mod.lock', locked: true, reason: 'Heated' },
    { ...base, type: 'mod.feature', scope: 'community', featured: true },
    { ...base, type: 'mod.lock', locked: false, reason: null },
    { ...base, type: 'mod.feature', scope: 'community', featured: false },
  ]);
});

describe('community bans', () => {
  test('a ban with an expiry and remove-content: content in that community removed, posting refused until the unban', async () => {
    const { instance, moderator, author, community, post, mod } = await setup();
    const victim = await seedActor(instance, 'Person', 'victim');
    const elsewhere = await seedActor(instance, 'Group', 'elsewhere');
    const victimPost = await seedPost(instance, community, victim);
    const victimReply = await seedComment(instance, post, victim);
    const victimOwnReply = await seedComment(instance, victimPost, victim);
    const untouched = await seedPost(instance, elsewhere, victim);
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const subject = { communityId: community.id, targetActorId: victim.id };

    const ban = await banFromCommunity(await grantFor('mod.ban', mod, subject), { reason: 'Spam', expiresAt, removeContent: true });
    expect(ban.removed).toEqual({ posts: 1, comments: 2 });
    expect(await db().select().from(communityBans)).toMatchObject([
      { communityId: community.id, actorId: victim.id, reason: 'Spam', bannedBy: moderator.id },
    ]);
    expect((await postRow(victimPost.id)).removedAt).toBeInstanceOf(Date);
    for (const id of [victimReply.id, victimOwnReply.id]) expect((await commentRow(id)).removedAt).toBeInstanceOf(Date);
    expect((await postRow(untouched.id)).removedAt).toBeNull();
    expect((await postRow(post.id)).removedAt).toBeNull();
    const asVictim = localUser(victim.id);
    expect(await authorize('post.create', asVictim, { communityId: community.id })).toEqual({ ok: false, reason: 'community.banned' });
    expect(await authorize('vote.cast', asVictim, { target: { kind: 'post', id: post.id } })).toEqual({
      ok: false,
      reason: 'community.banned',
    });
    expect(await authorize('post.create', asVictim, { communityId: elsewhere.id })).toMatchObject({ ok: true });
    expect(await authorize('post.create', localUser(author.id), { communityId: community.id })).toMatchObject({ ok: true });

    const unban = await unbanFromCommunity(await grantFor('mod.unban', mod, subject), { reason: 'Served' });
    expect(await db().select().from(communityBans)).toEqual([]);
    expect(await authorize('post.create', asVictim, { communityId: community.id })).toMatchObject({ ok: true });

    const [unbanned, banned] = await readModlog({ communityId: community.id }, { audience: 'staff' });
    expect(banned).toMatchObject({
      id: ban.modlogId,
      action: 'mod.ban',
      targetActorId: victim.id,
      targetApId: victim.apId,
      reason: 'Spam',
      details: { expiresAt, removeContent: true, removedPosts: 1, removedComments: 2 },
    });
    expect(unbanned).toMatchObject({ id: unban.modlogId, action: 'mod.unban', reason: 'Served' });
    const event = { type: 'mod.ban', v: 1, moderatorId: moderator.id, local: true, targetActorId: victim.id, targetApId: victim.apId };
    expect(await outboxEvents()).toEqual([
      { ...event, ...subject, modlogId: ban.modlogId, banned: true, removeContent: true, expiresAt, reason: 'Spam' },
      { ...event, ...subject, modlogId: unban.modlogId, banned: false, removeContent: false, expiresAt: null, reason: 'Served' },
    ]);
  });

  test('an expired ban grants nothing and a new ban replaces it; a ban that would already be over is refused', async () => {
    const { instance, community, mod } = await setup();
    const victim = await seedActor(instance, 'Person', 'victim');
    await seedBan(community, victim, { expiresAt: new Date(Date.now() - 1000), reason: 'Old' });
    const asVictim = localUser(victim.id);
    expect(await authorize('post.create', asVictim, { communityId: community.id })).toMatchObject({ ok: true });

    const subject = { communityId: community.id, targetActorId: victim.id };
    const before = await writeCounts();
    const past = new Date(Date.now() - 1000).toISOString();
    await expect(banFromCommunity(await grantFor('mod.ban', mod, subject), { expiresAt: past })).rejects.toBeInstanceOf(RangeError);
    expect(await writeCounts()).toEqual(before);

    await banFromCommunity(await grantFor('mod.ban', mod, subject), { reason: 'Again' });
    const rows = await db()
      .select()
      .from(communityBans)
      .where(and(eq(communityBans.communityId, community.id), eq(communityBans.actorId, victim.id)));
    expect(rows).toMatchObject([{ reason: 'Again', expiresAt: null }]);
    expect(await authorize('post.create', asVictim, { communityId: community.id })).toEqual({ ok: false, reason: 'community.banned' });
  });
});

test('a lock applied between authorize() and the write refuses the stale grant and writes nothing', async () => {
  const { instance, community, post, mod } = await setup();
  const second = await seedActor(instance, 'Person', 'second');
  await seedModerator(community, second);
  const stale = await grantFor('mod.lock', localUser(second.id), { postId: post.id });
  await lockPost(await grantFor('mod.lock', mod, { postId: post.id }), { reason: 'First' });
  const before = await writeCounts();
  const attempt = lockPost(stale, { reason: 'Second' });
  await expect(attempt).rejects.toBeInstanceOf(Refused);
  await expect(attempt).rejects.toMatchObject({ action: 'mod.lock', reason: 'target.locked' });
  expect(await writeCounts()).toEqual(before);
});

test("an action relayed by the owning community's Announce is logged with that authority and emitted as not local", async () => {
  const lemmy = await seedInstance('lemmy.test', false);
  await seedInstance('feddit.test');
  const remoteModerator = await seedActor(lemmy, 'Person', 'someone');
  const technology = await seedActor(lemmy, 'Group', 'technology');
  const post = await seedPost(lemmy, technology, remoteModerator);
  const announceApId = 'https://lemmy.test/activities/announce/1';
  const principal = { kind: 'remote', actorId: remoteModerator.id, announcedBy: { communityId: technology.id, announceApId } } as const;
  const target = { kind: 'post', id: post.id } as const;
  const activityApId = 'https://lemmy.test/activities/delete/1';
  const { modlogId } = await removeContent(await grantFor('mod.remove', principal, { target }), { reason: 'Spam', activityApId });
  const [entry] = await readModlog({}, { audience: 'staff', trustedInstances: ['lemmy.test'] });
  expect(entry).toMatchObject({
    id: modlogId,
    actorApId: remoteModerator.apId,
    reason: 'Spam',
    authority: { kind: 'community-announce', communityId: technology.id, announceApId },
  });
  expect(await outboxEvents()).toMatchObject([{ type: 'mod.remove', modlogId, local: false, removed: true }]);
});
