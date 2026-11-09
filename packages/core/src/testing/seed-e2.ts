import type { Principal } from '@peblish/schema/authz';
import type { OutboxEvent } from '@peblish/schema/events';
import { asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { createCommentAs, deleteCommentAs } from '../comments/actions.ts';
import { resolveReplyTarget, storeRemoteComment } from '../comments/remote.ts';
import { closePools } from '../db/pools.ts';
import { banFromCommunity, unbanFromCommunity } from '../moderation/ban.ts';
import { removeContent, restoreContent } from '../moderation/remove.ts';
import { consumer } from '../notifications/consumer.ts';
import { db } from '../db/read.ts';
import { modlog } from '../db/tables/moderation.ts';
import { writer } from '../db/write.ts';
import { notifications } from '../notifications/tables.ts';
import { ensureCursors, processBatch } from '../outbox/worker.ts';
import { grantFor, seedModerator, seedPost } from './seed-az.ts';
import { seedPostWorld } from './seed-b1.ts';
import { localUser, seedActor, seedInstance } from './seed.ts';
import { tx } from '../tx/tx.ts';
import type { NotificationKind } from '../notifications/view.ts';

// Lane E2's seeds: the notifications consumer run for real, the notices it wrote, and what
// e2e/notifications runs against. Test code only. The people and communities come from
// seedPostWorld (seed-b1.ts); this adds nothing to them but the helpers below.

/**
 * seedPostWorld's cast plus the local instance actor the consumer acts as (people: author,
 * reader, moderator, owner, admin, banned and remoteAuthor; communities: open, restricted,
 * removed, remote), so `systemPrincipal` works.
 */
export async function seedInboxWorld() {
  const world = await seedPostWorld();
  await seedActor(world.instances.local, 'Application', 'feddit.test');
  return world;
}

/** Emits an event as the transaction that caused it would have, for a test that seeds rows directly. */
export const emitEvent = (event: OutboxEvent) => tx((t) => t.emit(event));

/**
 * Runs the notifications consumer over the outbox until its cursor has passed every event,
 * through the real processBatch (its cursor and transaction included). The horizon lags: it is
 * the oldest transaction running anywhere on the server, so on a busy machine a batch can move
 * nothing while events wait. This waits for the cursor, not for a quiet batch.
 */
export async function drainNotices(): Promise<void> {
  await ensureCursors([consumer]);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await processBatch(consumer);
    const [waiting] = await db().execute<{ n: number }>(
      sql`select count(*)::int as n from outbox o, outbox_cursors c
        where c.consumer = ${consumer.name} and (o.tx_id, o.id) > (c.tx_id, c.event_id)`,
    );
    if (waiting?.n === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the notifications consumer did not catch up');
}

/** A person's notices, oldest first. */
export const noticesOf = (recipientId: string) =>
  db().select().from(notifications).where(eq(notifications.recipientId, recipientId)).orderBy(asc(notifications.id));

/** The kinds a person holds, in order, for compact assertions. */
export async function kindsOf(recipientId: string): Promise<NotificationKind[]> {
  return (await noticesOf(recipientId)).map((row) => row.kind);
}

export const noticeCount = async () =>
  (
    await db()
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
  )[0]!.n;

/** True when the outbox row of `type` was written by the same transaction that wrote notice `id` (xmin matches tx_id). */
export async function sameTransactionAsNotice(id: string, type: string): Promise<boolean> {
  const [row] = await db().execute<{ same: boolean }>(
    sql`select exists (
      select 1 from outbox o, notifications r
      where r.id = ${id} and o.type = ${type} and (o.tx_id::text::numeric % 4294967296)::text = r.xmin::text
    ) as same`,
  );
  return row?.same === true;
}

/** Writes a notice directly, for read-model and mark tests that need rows without events. */
export async function seedNotice(row: typeof notifications.$inferInsert) {
  const [created] = await writer().insert(notifications).values(row).returning();
  return created!;
}

/**
 * A modlog row, by default a site ban by `moderator` (the ban lane's mutation does not exist
 * yet), so an event or a notice can name a real one. A moderator on another instance gives an
 * entry whose reason is withheld unless that instance is trusted.
 */
export async function seedModlog(
  moderator: { id: string; apId: string },
  target: { id: string; apId: string },
  extra: Partial<typeof modlog.$inferInsert> = {},
) {
  const [row] = await writer()
    .insert(modlog)
    .values({
      action: 'ban.site',
      actorId: moderator.id,
      actorApId: moderator.apId,
      targetActorId: target.id,
      targetApId: target.apId,
      reason: 'Spam',
      authority: { kind: 'site-admin', actorId: moderator.id },
      ...extra,
    })
    .returning();
  return row!;
}

/** A local person comments on `postId` (under `parentId` when given) through the real action; the new id comes back. */
export async function say(person: { id: string }, postId: string, bodyMd: string, parentId: string | null = null): Promise<string> {
  const created = await createCommentAs(localUser(person.id), { postId, parentId }, { bodyMd });
  if (!created.ok) throw new Error(`comment refused: ${created.reason}`);
  return created.id;
}

/** A remote person's comment on the object with `replyToApId`, stored the way the inbound handler stores it. */
export async function remoteSay(author: { id: string }, replyToApId: string, raw: unknown = { type: 'Note' }): Promise<string> {
  const principal: Principal = { kind: 'remote', actorId: author.id, announcedBy: null };
  const subject = await resolveReplyTarget(replyToApId);
  if (!subject) throw new Error(`no object ${replyToApId}`);
  const stored = await storeRemoteComment(await grantFor('comment.create', principal, subject), {
    apId: `https://remote.test/comment/${uuidv7()}`,
    inReplyToApId: replyToApId,
    bodyMd: null,
    contentHtml: '<p>Hello from Lemmy</p>',
    language: null,
    publishedAt: new Date(),
    editedAt: null,
    raw,
  });
  return stored.id;
}

/**
 * What e2e/notifications runs against: accounts that can sign in (lane A's seedAccount), and the
 * inbox of `me` filled by the real actions and the real consumer. Every run uses fresh names, so
 * the lane database can keep earlier runs.
 *
 * `me` has 11 unread: five replies (one to a post, one to a comment, a remote one, one in a
 * sensitive post, one whose comment is deleted afterwards), a mention, a removal, a removal
 * and a restore, a ban and an unban. `quiet` has none; `busy` has 30 unread mentions (two pages).
 */
async function e2e() {
  const { seedAccount: login, PASSWORD } = await import('./seed-a.ts');
  const { localInstance } = await import('../db/local-instance.ts');
  const suffix = Math.random().toString(36).slice(2, 8);
  const origin = (await localInstance(db())).origin;
  const host = new URL(origin).host;
  const instance = { ...(await localInstance(db())), domain: host, local: true };
  const [me, replier, mod, quiet, busy] = await Promise.all(
    ['me', 'reply', 'mod', 'quiet', 'busy'].map((role) => login(`${role}_${suffix}`)),
  );
  const people = { me: me!, replier: replier!, mod: mod!, quiet: quiet!, busy: busy! };
  const community = await seedActor(instance, 'Group', `inbox_${suffix}`);
  await seedModerator(community, { id: people.mod.actorId });
  const remoteInstance = await seedInstance(`lemmy-${suffix}.test`, false);
  const remy = await seedActor(remoteInstance, 'Person', `remy_${suffix}`);

  const mine = { id: people.me.actorId };
  const theirs = { id: people.replier.actorId };
  const myPost = await seedPost(instance, community, mine, { title: `My post ${suffix}`, bodyMd: 'Body' });
  const elsewhere = await seedPost(instance, community, theirs, { title: `Elsewhere ${suffix}`, bodyMd: 'Body' });
  const secret = await seedPost(instance, community, mine, { title: `Secret ${suffix}`, bodyMd: 'Body', sensitive: true });

  await say(theirs, myPost.id, `Great post ${suffix}`);
  const myQuestion = await say(mine, elsewhere.id, `A question ${suffix}`);
  await say(theirs, elsewhere.id, `The answer ${suffix}`, myQuestion);
  await remoteSay(remy, myPost.apId);
  await say(theirs, elsewhere.id, `Hello @${people.me.name}@${host}, look at this ${suffix}`);
  await say(theirs, secret.id, `Hidden words ${suffix}`);
  const doomed = await say(theirs, myPost.id, `Deleted later ${suffix}`);

  const rude = await say(mine, elsewhere.id, `Rude words ${suffix}`);
  const mistake = await say(mine, elsewhere.id, `Mistaken removal ${suffix}`);
  const moderator = { kind: 'local', actorId: people.mod.actorId, siteRole: 'user' } as const;
  const asMod = <A extends 'mod.remove' | 'mod.restore'>(action: A, id: string) =>
    grantFor(action, moderator, { target: { kind: 'comment', id } });
  await removeContent(await asMod('mod.remove', rude), { reason: 'Rule 3: no ads' });
  await removeContent(await asMod('mod.remove', mistake), { reason: 'Looked like spam' });
  await restoreContent(await asMod('mod.restore', mistake), { reason: 'My mistake' });
  const ban = { communityId: community.id, targetActorId: people.me.actorId };
  await banFromCommunity(await grantFor('mod.ban', moderator, ban), { reason: 'Spam wave' });
  await unbanFromCommunity(await grantFor('mod.unban', moderator, ban), { reason: 'Served' });

  await writer()
    .insert(notifications)
    .values(Array.from({ length: 30 }, () => ({ recipientId: people.busy.actorId, kind: 'mention' as const, refId: uuidv7() })));
  await drainNotices();
  // A comment deleted after its notice was written: the inbox then shows the word, not the text.
  await deleteCommentAs(localUser(people.replier.actorId), doomed);

  const [first] = await noticesOf(people.me.actorId);
  return {
    password: PASSWORD,
    suffix,
    host,
    me: { name: people.me.name },
    replier: { name: people.replier.name },
    quiet: { name: people.quiet.name },
    busy: { name: people.busy.name },
    remote: { handle: `${remy.name}@${remoteInstance.domain}` },
    firstNoticeId: first!.id,
    community: community.name,
    myPostId: myPost.id,
    myPostTitle: myPost.title,
  };
}

if (import.meta.main) {
  try {
    const [command] = process.argv.slice(2);
    if (command === 'e2e') console.log(JSON.stringify(await e2e()));
    else throw new Error('usage: node packages/core/src/testing/seed-e2.ts e2e');
  } finally {
    await closePools();
  }
}
