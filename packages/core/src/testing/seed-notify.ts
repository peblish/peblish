import { eq, and } from 'drizzle-orm';
import { closePools } from '../db/pools.ts';
import { db } from '../db/read.ts';
import { follows } from '../db/tables/follows.ts';
import { localInstance } from '../db/local-instance.ts';
import { acceptFollow } from '../follows/follow.ts';
import { followAs } from '../follows/service.ts';
import { removeContent } from '../moderation/remove.ts';
import { markNotificationAs } from '../notifications/service.ts';
import { PASSWORD, seedAccount } from './seed-a.ts';
import { grantFor, seedModerator, seedPost } from './seed-az.ts';
import { drainNotices, noticesOf, say } from './seed-e2.ts';
import { localUser, seedActor, seedInstance } from './seed.ts';
import { actors } from '../db/tables/actors.ts';
import { posts } from '../db/tables/content.ts';
import { writer as dbWriter } from '../db/write.ts';
import { watchThreadAs } from '../watches/watches.ts';

// Lane f-notify's seeds: the cast of the thread follows' and the inbox's branch 5 cases in
// e2e/notifications, on the lane database (DATABASE_URL from scripts/lane.sh), on fresh names every
// run. Test code only.
//
//   node packages/core/src/testing/seed-notify.ts e2e                    prints the cast as JSON
//   node packages/core/src/testing/seed-notify.ts comment <post> <name>  <name> comments on <post>; the notices are written
//
// `reader` follows nothing yet and has, written by the real consumer: a remote community's accept
// of their request to join, and a removal of their comment.
// `marker` has two unread replies and one read, for Mark all read and its Undo. `writer` wrote the
// thread `post` and `markerPost`; `other` comments when a case asks. `fan` follows `gatedPost`, which
// is flagged sensitive afterwards, and has not declared 16+, so the gate stands there. Invented content only.

async function cast() {
  const suffix = Math.random().toString(36).slice(2, 8);
  const origin = (await localInstance(db())).origin;
  const host = new URL(origin).host;
  const instance = { ...(await localInstance(db())), domain: host, local: true };
  const [reader, writer, other, mod, marker, fan] = await Promise.all(
    ['reader', 'writer', 'other', 'mod', 'marker', 'fan'].map((role) => seedAccount(`f${role}_${suffix}`)),
  );
  const community = await seedActor(instance, 'Group', `follows_${suffix}`);
  await seedModerator(community, { id: mod!.actorId });
  const post = await seedPost(instance, community, { id: writer!.actorId }, { title: `A thread to follow ${suffix}`, bodyMd: 'Body' });
  const markerPost = await seedPost(instance, community, { id: marker!.actorId }, { title: `Marker's post ${suffix}`, bodyMd: 'Body' });
  const gatedPost = await seedPost(
    instance,
    community,
    { id: writer!.actorId },
    { title: `A thread flagged later ${suffix}`, bodyMd: 'Body' },
  );
  const watched = await watchThreadAs(localUser(fan!.actorId), { postId: gatedPost.id });
  if (!watched.ok) throw new Error(`watch refused: ${watched.reason}`);
  await dbWriter().update(posts).set({ sensitive: true }).where(eq(posts.id, gatedPost.id));

  // A remote community accepts the reader's request to join.
  const peer = await seedInstance(`lemmy-${suffix}.test`, false);
  const remote = await seedActor(peer, 'Group', `faraway_${suffix}`);
  const asked = await followAs(localUser(reader!.actorId), remote.id);
  if (!asked.ok) throw new Error(`follow refused: ${asked.reason}`);
  const [row] = await db()
    .select({ apId: follows.apId })
    .from(follows)
    .where(and(eq(follows.followerId, reader!.actorId), eq(follows.followeeId, remote.id)));
  const [person] = await db().select({ apId: actors.apId }).from(actors).where(eq(actors.id, reader!.actorId));
  const answer = { kind: 'remote', actorId: remote.id, announcedBy: null } as const;
  await acceptFollow(await grantFor('follow.accept', answer, { followApId: row!.apId!, followerApId: person!.apId }), undefined);

  // A removal of the reader's comment (the review address is a site setting other specs own, so it is left alone).
  const rude = await say({ id: reader!.actorId }, post.id, `Off topic ${suffix}`);
  const moderator = { kind: 'local', actorId: mod!.actorId, siteRole: 'user' } as const;
  await removeContent(await grantFor('mod.remove', moderator, { target: { kind: 'comment', id: rude } }), { reason: 'Rule 7: on topic' });

  // Two unread replies to the marker, and one read.
  await say({ id: other!.actorId }, markerPost.id, `First reply ${suffix}`);
  await say({ id: other!.actorId }, markerPost.id, `Second reply ${suffix}`);
  const read = await say({ id: writer!.actorId }, markerPost.id, `Read reply ${suffix}`);
  await drainNotices();
  const [readNotice] = (await noticesOf(marker!.actorId)).filter((notice) => notice.refId === read);
  const marked = await markNotificationAs(localUser(marker!.actorId), readNotice!.id, true);
  if (!marked.ok) throw new Error(`mark refused: ${marked.reason}`);

  return {
    password: PASSWORD,
    suffix,
    reader: { name: reader!.name },
    writer: { name: writer!.name },
    other: { name: other!.name },
    marker: { name: marker!.name },
    post: { id: post.id, title: post.title },
    markerPost: { id: markerPost.id },
    fan: { name: fan!.name },
    gatedPost: { id: gatedPost.id, title: gatedPost.title },
    remote: { name: remote.name, handle: `${remote.name}@${peer.domain}` },
  };
}

/** `name` comments on `postId` through the real action, and the consumer writes its notices. */
async function comment(postId: string, name: string) {
  const [person] = await db()
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.name, name), eq(actors.local, true)));
  if (!person) throw new Error(`no local person ${name}`);
  const id = await say(person, postId, `A new comment ${Math.random().toString(36).slice(2, 8)}`);
  await drainNotices();
  return { id };
}

if (import.meta.main) {
  try {
    const [command, ...rest] = process.argv.slice(2);
    if (command === 'e2e') console.log(JSON.stringify(await cast()));
    else if (command === 'comment') console.log(JSON.stringify(await comment(rest[0]!, rest[1]!)));
    else throw new Error('usage: node packages/core/src/testing/seed-notify.ts e2e | comment <post> <name>');
  } finally {
    await closePools();
  }
}
