import type { ActingPrincipal, Principal } from '@peblish/schema/authz';
import { asc, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { authorize } from '../authz/authorize.ts';
import type { ActionName, SubjectOf } from '../authz/policy.ts';
import { db } from '../db/read.ts';
import { authUser } from '../db/tables/auth.ts';
import { comments, posts } from '../db/tables/content.ts';
import { communityModerators, modlog } from '../db/tables/moderation.ts';
import { outbox } from '../db/tables/outbox.ts';
import { writer } from '../db/write.ts';
import { communityBans, communityRemovals } from '../moderation/tables.ts';
import { seedActor, seedInstance } from './seed.ts';

// Lane AZ's seeds: communities with moderators, posts in each state, bans. Test code only.

type Instance = { id: string; domain: string; local: boolean };
type Row = { id: string };

/** A local Person whose account is a site admin, with two-factor on (an admin counts as one only then). */
export async function seedAdmin(instance: Instance, name: string) {
  const [user] = await writer()
    .insert(authUser)
    .values({ name, email: `${name.toLowerCase()}@${instance.domain}`, role: 'admin', twoFactorEnabled: true })
    .returning();
  return seedActor(instance, 'Person', name, { userId: user!.id });
}

export const admin = (actorId: string): ActingPrincipal => ({ kind: 'local', actorId, siteRole: 'admin' });

/** The grant authorize() issues, or a thrown Error naming the refusal. */
export async function grantFor<A extends ActionName>(action: A, principal: Principal, subject: SubjectOf<A>) {
  const decision = await authorize(action, principal, subject);
  if (!decision.ok) throw new Error(`${action} refused: ${decision.reason}`);
  return decision.grant;
}

/** Every outbox payload so far, oldest first. */
export const outboxEvents = async () =>
  (await db().select({ payload: outbox.payload }).from(outbox).orderBy(asc(outbox.id))).map((row) => row.payload);

/** Modlog rows and outbox rows so far: what a refused mutation must leave unchanged. */
export async function writeCounts() {
  const [row] = await db().execute<{ modlog: number; outbox: number }>(
    sql`select (select count(*) from ${modlog})::int as modlog, (select count(*) from ${outbox})::int as outbox`,
  );
  return row;
}

/** A community_moderators row: a local moderator, confirmed now, unless `extra` says otherwise. */
export async function seedModerator(community: Row, moderator: Row, extra: Partial<typeof communityModerators.$inferInsert> = {}) {
  await writer()
    .insert(communityModerators)
    .values({ communityId: community.id, moderatorId: moderator.id, role: 'moderator', source: 'local', verifiedAt: new Date(), ...extra });
}

export async function seedBan(community: Row, actor: Row, extra: Partial<typeof communityBans.$inferInsert> = {}) {
  await writer()
    .insert(communityBans)
    .values({ communityId: community.id, actorId: actor.id, ...extra });
}

export async function seedCommunityRemoval(community: Row) {
  await writer().insert(communityRemovals).values({ communityId: community.id });
}

/** A post in `community`, on the instance the community lives on, with `extra` columns (state flags). */
export async function seedPost(instance: Instance, community: Row, author: Row, extra: Partial<typeof posts.$inferInsert> = {}) {
  const id = uuidv7();
  const [row] = await writer()
    .insert(posts)
    .values({
      id,
      apId: `https://${instance.domain}/ap/post/${id}`,
      local: instance.local,
      instanceId: instance.id,
      authorId: author.id,
      communityId: community.id,
      title: `Post ${id}`,
      publishedAt: new Date(),
      ...extra,
    })
    .returning();
  return row!;
}

/** A top-level comment on `post`. */
export async function seedComment(instance: Instance, post: Row, author: Row, extra: Partial<typeof comments.$inferInsert> = {}) {
  const id = uuidv7();
  const [row] = await writer()
    .insert(comments)
    .values({
      id,
      apId: `https://${instance.domain}/ap/comment/${id}`,
      local: instance.local,
      instanceId: instance.id,
      postId: post.id,
      authorId: author.id,
      path: id.replaceAll('-', '_'),
      bodyMd: 'A comment',
      publishedAt: new Date(),
      ...extra,
    })
    .returning();
  return row!;
}

/** The target states of the role table, each a post with one comment. */
export const targetStates = ['normal', 'locked', 'pinned', 'removed', 'deleted', 'community removed'] as const;
export type TargetState = (typeof targetStates)[number];

const stateColumns = (state: TargetState) => {
  const past = new Date(Date.now() - 60_000);
  switch (state) {
    case 'locked':
      return { post: { locked: true }, comment: {} };
    case 'pinned':
      return { post: { featuredCommunity: true }, comment: {} };
    case 'removed':
      return { post: { removedAt: past }, comment: { removedAt: past } };
    case 'deleted':
      return { post: { deletedAt: past }, comment: { deletedAt: past } };
    default:
      return { post: {}, comment: {} };
  }
};

export type Subject = { communityId: string; postId: string; commentId: string };

/** A post and its comment in each target state; 'community removed' uses the removed community. */
async function seedStates(where: { instance: Instance; live: Row; removed: Row }, author: Row): Promise<Record<TargetState, Subject>> {
  const seedOne = async (state: TargetState): Promise<Subject> => {
    const community = state === 'community removed' ? where.removed : where.live;
    const columns = stateColumns(state);
    const post = await seedPost(where.instance, community, author, columns.post);
    const comment = await seedComment(where.instance, post, author, columns.comment);
    return { communityId: community.id, postId: post.id, commentId: comment.id };
  };
  return {
    normal: await seedOne('normal'),
    locked: await seedOne('locked'),
    pinned: await seedOne('pinned'),
    removed: await seedOne('removed'),
    deleted: await seedOne('deleted'),
    'community removed': await seedOne('community removed'),
  };
}

/**
 * The world of the role table: a local and a remote community, each with a post and comment
 * in every target state ('community removed' lives in a removed twin of each community), and:
 * - in both local communities: `moderator`, `owner`, and `expired` (a moderator row past its
 *   expiry);
 * - `banned` banned from all four communities; `victim` banned from none;
 * - `admin` a site admin; `user` and `author` plain local users (author wrote every post);
 * - `remoteUser` on lemmy.test, which hosts the remote community, and `elsewhere`, another
 *   remote community, on other.test.
 */
export async function seedModerationWorld() {
  const local = await seedInstance('feddit.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const other = await seedInstance('other.test', false);
  const people = {
    user: await seedActor(local, 'Person', 'user'),
    author: await seedActor(local, 'Person', 'author'),
    moderator: await seedActor(local, 'Person', 'moderator'),
    expired: await seedActor(local, 'Person', 'expired'),
    owner: await seedActor(local, 'Person', 'owner'),
    admin: await seedAdmin(local, 'admin'),
    banned: await seedActor(local, 'Person', 'banned'),
    victim: await seedActor(local, 'Person', 'victim'),
    remoteUser: await seedActor(lemmy, 'Person', 'someone'),
  };
  const elsewhere = await seedActor(other, 'Group', 'elsewhere');
  const communities = {
    local: { instance: local, live: await seedActor(local, 'Group', 'announcements'), removed: await seedActor(local, 'Group', 'closed') },
    remote: { instance: lemmy, live: await seedActor(lemmy, 'Group', 'technology'), removed: await seedActor(lemmy, 'Group', 'shut') },
  };
  for (const { live, removed } of Object.values(communities)) {
    await seedBan(live, people.banned);
    await seedBan(removed, people.banned);
    await seedCommunityRemoval(removed);
  }
  for (const community of [communities.local.live, communities.local.removed]) {
    await seedModerator(community, people.moderator);
    await seedModerator(community, people.owner, { role: 'owner' });
    await seedModerator(community, people.expired, { expiresAt: new Date(Date.now() - 60_000) });
  }
  const subjects = {
    local: await seedStates(communities.local, people.author),
    remote: await seedStates(communities.remote, people.author),
  };
  return { instances: { local, lemmy, other }, people, elsewhere, communities, subjects };
}

/** A promise gate, so two connections interleave deterministically. */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

/** True while some backend in this database waits on a lock. */
export async function someoneWaitsOnALock() {
  const [row] = await db().execute<{ waiting: number }>(
    sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
  );
  return (row?.waiting ?? 0) > 0;
}
