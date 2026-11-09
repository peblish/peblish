import { sql } from 'drizzle-orm';
import { db } from '../db/read.ts';
import { authUser } from '../db/tables/auth.ts';
import { writer } from '../db/write.ts';
import { ageDeclarations } from '../identity/tables.ts';
import { seedAdmin, seedBan, seedCommunityRemoval, seedModerator, seedPost } from './seed-az.ts';
import { seedActor, seedInstance } from './seed.ts';

// Lane B1's seeds: people with real accounts, communities of each kind, and the author's posts
// in each state. Test code only.

type Instance = { id: string; domain: string; local: boolean };

/** A local Person with an account. The email is verified unless `extra` says otherwise. */
export async function seedAccount(instance: Instance, name: string, extra: Partial<typeof authUser.$inferInsert> = {}) {
  const [user] = await writer()
    .insert(authUser)
    .values({ name, email: `${name.toLowerCase()}@${instance.domain}`, emailVerified: true, ...extra })
    .returning();
  return seedActor(instance, 'Person', name, { userId: user!.id });
}

/** The 16+ declaration sign-up records; without it a person never sees sensitive posts. */
export async function declareAge(person: { id: string }) {
  await writer().insert(ageDeclarations).values({ actorId: person.id });
}

/** The states an author's post can be in for the author actions; 'community removed' sits in a removed community. */
export const postStates = ['normal', 'locked', 'removed', 'deleted', 'community removed'] as const;
export type PostState = (typeof postStates)[number];

const past = () => new Date(Date.now() - 60_000);
const stateColumns = (state: PostState) =>
  state === 'locked' ? { locked: true } : state === 'removed' ? { removedAt: past() } : state === 'deleted' ? { deletedAt: past() } : {};

/**
 * The world of the post and vote policy tables:
 * - local people with accounts: `author`, `unverified` (email not verified), `reader`,
 *   `moderator`, `owner`, `admin` (a site admin with two-factor), `banned` (banned from `open`);
 * - `remoteAuthor` on lemmy.test;
 * - communities: `open`, `restricted` (moderators only), `removed` (by an admin) on this
 *   instance; `remote` and `remoteRestricted` on lemmy.test; `moderator` and `owner` moderate
 *   `restricted` and `open`;
 * - `posts.local[state]` are `author`'s posts in `open` (in `removed` for 'community removed'),
 *   `posts.banned` is the banned person's post in `open`, `posts.remote[state]` are
 *   `remoteAuthor`'s posts in `remote`.
 */
export async function seedPostWorld() {
  const local = await seedInstance('feddit.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const people = {
    author: await seedAccount(local, 'author'),
    unverified: await seedAccount(local, 'unverified', { emailVerified: false }),
    reader: await seedAccount(local, 'reader'),
    moderator: await seedAccount(local, 'moderator'),
    owner: await seedAccount(local, 'owner'),
    admin: await seedAdmin(local, 'admin'),
    banned: await seedAccount(local, 'banned'),
    remoteAuthor: await seedActor(lemmy, 'Person', 'remote_author'),
  };
  const communities = {
    open: await seedActor(local, 'Group', 'open'),
    restricted: await seedActor(local, 'Group', 'restricted', { postingRestrictedToMods: true }),
    removed: await seedActor(local, 'Group', 'closed'),
    remote: await seedActor(lemmy, 'Group', 'technology'),
    remoteRestricted: await seedActor(lemmy, 'Group', 'announcements', { postingRestrictedToMods: true }),
  };
  await seedCommunityRemoval(communities.removed);
  await seedBan(communities.open, people.banned);
  for (const community of [communities.open, communities.restricted]) {
    await seedModerator(community, people.moderator);
    await seedModerator(community, people.owner, { role: 'owner' });
  }
  const seedStates = async (instance: Instance, community: { id: string }, removedCommunity: { id: string }, author: { id: string }) => {
    const row = async (state: PostState) =>
      (await seedPost(instance, state === 'community removed' ? removedCommunity : community, author, stateColumns(state))).id;
    return {
      normal: await row('normal'),
      locked: await row('locked'),
      removed: await row('removed'),
      deleted: await row('deleted'),
      'community removed': await row('community removed'),
    };
  };
  const removedRemote = await seedActor(lemmy, 'Group', 'shut');
  await seedCommunityRemoval(removedRemote);
  const posts = {
    local: await seedStates(local, communities.open, communities.removed, people.author),
    banned: (await seedPost(local, communities.open, people.banned)).id,
    remote: await seedStates(lemmy, communities.remote, removedRemote, people.remoteAuthor),
  };
  return { instances: { local, lemmy }, people, communities, posts };
}

/** True when the outbox row of `type` was written by the same transaction that wrote `table`'s row `id` (xmin matches tx_id). */
export async function sameTransaction(table: 'posts' | 'votes', id: string, type: string): Promise<boolean> {
  const [row] = await db().execute<{ same: boolean }>(
    sql`select exists (
      select 1 from outbox o, ${sql.raw(table)} r
      where r.id = ${id} and o.type = ${type} and (o.tx_id::text::numeric % 4294967296)::text = r.xmin::text
    ) as same`,
  );
  return row?.same === true;
}
