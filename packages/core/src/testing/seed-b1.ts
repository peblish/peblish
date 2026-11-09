import { eq, sql } from 'drizzle-orm';
import { closePools } from '../db/pools.ts';
import { db } from '../db/read.ts';
import { authUser } from '../db/tables/auth.ts';
import { posts } from '../db/tables/content.ts';
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

/**
 * What e2e/post runs against: accounts that can sign in (lane A's seedAccount: known password,
 * verified email, 16+ declaration), a community with a moderator, and posts in the states the
 * page shows. Every run uses fresh names, so the lane database can keep earlier runs. `secret`
 * is in the sensitive post's title, link and body: the signed-out page must never carry it.
 */
async function e2e() {
  const { seedAccount: seedLogin, PASSWORD } = await import('./seed-a.ts');
  const { localInstance } = await import('../db/local-instance.ts');
  const suffix = Math.random().toString(36).slice(2, 8);
  const secret = `Secret${suffix}`;
  const host = new URL((await localInstance(db())).origin).host;
  const instance = { ...(await localInstance(db())), domain: host, local: true };
  const [author, moderator, viewer, undeclared] = await Promise.all(
    ['author', 'mod', 'viewer', 'minor'].map((role) => seedLogin(`${role}_${suffix}`)),
  );
  if (!author || !moderator || !viewer || !undeclared) throw new Error('accounts');
  await writer().delete(ageDeclarations).where(eq(ageDeclarations.actorId, undeclared.actorId));
  const community = await seedActor(instance, 'Group', `e2e_${suffix}`);
  await seedModerator(community, { id: moderator.actorId });
  const post = (extra: Partial<typeof posts.$inferInsert>) => seedPost(instance, community, { id: author.actorId }, extra);
  // Communities an admin removed and one that was deleted: their posts are not found, for anyone.
  const removedCommunity = await seedActor(instance, 'Group', `e2e_removed_${suffix}`);
  await seedCommunityRemoval(removedCommunity);
  const deletedCommunity = await seedActor(instance, 'Group', `e2e_deleted_${suffix}`, { deletedAt: new Date() });
  const inClosed = (closed: { id: string }) => seedPost(instance, closed, { id: author.actorId }, { title: `Closed post ${suffix}` });
  const body = (text: string) => ({ bodyMd: text, contentHtml: `<p>${text}</p>` });
  const row = (value: { id: string }) => value.id;
  return {
    password: PASSWORD,
    secret,
    community: { name: community.name, handle: community.name },
    author: { name: author.name, handle: author.name, actorId: author.actorId },
    moderator: { name: moderator.name },
    viewer: { name: viewer.name },
    undeclared: { name: undeclared.name },
    posts: {
      plain: row(await post({ title: `Plain post ${suffix}`, url: 'https://example.test/article', ...body(`Plain **body** ${suffix}`) })),
      deletable: row(await post({ title: `Deletable post ${suffix}`, ...body(`Deletable body ${suffix}`) })),
      removable: row(await post({ title: `Removable post ${suffix}`, ...body(`Removable body ${suffix}`) })),
      sensitive: row(
        await post({
          title: `${secret} title`,
          url: `https://example.test/${secret}`,
          sensitive: true,
          thumbnailUrl: `https://example.test/${secret}.png`,
          ...body(`${secret} body`),
        }),
      ),
      deleted: row(await post({ title: `Deleted post ${suffix}`, deletedAt: new Date(), ...body(`Deleted body ${suffix}`) })),
      inRemovedCommunity: row(await inClosed(removedCommunity)),
      inDeletedCommunity: row(await inClosed(deletedCommunity)),
    },
  };
}

if (import.meta.main) {
  try {
    const [command] = process.argv.slice(2);
    if (command === 'e2e') console.log(JSON.stringify(await e2e()));
    else throw new Error('usage: node packages/core/src/testing/seed-b1.ts e2e');
  } finally {
    await closePools();
  }
}
