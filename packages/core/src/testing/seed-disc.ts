import { eq, sql } from 'drizzle-orm';
import { closePools } from '../db/pools.ts';
import { db } from '../db/read.ts';
import { localInstance } from '../db/local-instance.ts';
import { ageDeclarations } from '../identity/tables.ts';
import { writer } from '../db/write.ts';
import { seedCommunityRemoval, seedPost } from './seed-az.ts';
import { seedFollow } from './seed-c1.ts';
import { seedPerson } from './seed-f.ts';
import { seedActor, seedInstance } from './seed.ts';

// Lane DISC's seeds: a small world for the directory and resolve tests, and the rows the e2e
// spec needs on the lane database (`node packages/core/src/testing/seed-disc.ts e2e`). Test code only.

const day = 24 * 60 * 60 * 1000;

/**
 * The directory's cast, on the local instance `feddit.test` and the remote ones `lemmy.test`
 * and `piefed.test`:
 * - local communities `news` (3 members, one waiting; 2 authors posted this week, a third
 *   10 days ago, and a deleted post counts for nothing), `art` (1 member, no posts, the newest)
 *   and `adult` (sensitive);
 * - remote communities `technology` (2 members, 3 authors this week, a summary full of markup),
 *   `quiet` on piefed.test, `adultRemote` (sensitive) and `scary` (nsfl), never listed; `gone`
 *   (removed by an admin) and `deleted`;
 * - `viewer` (declared 16+, follows `technology` and waits on `news`), `minor` (has not declared).
 */
export async function seedDirectoryWorld() {
  const local = await seedInstance('feddit.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const piefed = await seedInstance('piefed.test', false);
  const [viewer, minor, member1, member2, member3] = await Promise.all(
    ['viewer', 'minor', 'member1', 'member2', 'member3'].map((name) => seedPerson(local, name)),
  );
  await writer().insert(ageDeclarations).values({ actorId: viewer!.id });
  const authors = await Promise.all([1, 2, 3].map((n) => seedActor(lemmy, 'Person', `author${n}`)));

  const old = new Date('2026-01-01T00:00:00Z');
  const communities = {
    news: await seedActor(local, 'Group', 'News', {
      displayName: 'World news',
      summaryHtml: '<p>News from <b>around</b> the world</p>',
      publishedAt: new Date(Date.now() - 30 * day),
      createdAt: old,
    }),
    art: await seedActor(local, 'Group', 'art', { createdAt: new Date() }),
    adult: await seedActor(local, 'Group', 'adult', { sensitive: true, createdAt: old }),
    technology: await seedActor(lemmy, 'Group', 'technology', {
      displayName: 'Technology',
      summaryHtml:
        '<p>Gadgets &amp; <a href="https://example.test">code</a></p><script>alert(1)</script><img src="https://evil.test/x.png">',
      fetchedAt: new Date('2026-11-01T12:00:00Z'),
      createdAt: old,
    }),
    quiet: await seedActor(piefed, 'Group', 'quiet', {
      fetchedAt: new Date('2026-11-02T12:00:00Z'),
      createdAt: new Date(Date.now() - 2 * day),
    }),
    adultRemote: await seedActor(lemmy, 'Group', 'adult_remote', { sensitive: true, createdAt: old }),
    scary: await seedActor(piefed, 'Group', 'scary', { nsfl: true, createdAt: old }),
    gone: await seedActor(lemmy, 'Group', 'gone', { createdAt: old }),
    deleted: await seedActor(lemmy, 'Group', 'deleted', { deletedAt: new Date(), createdAt: old }),
  };
  await seedCommunityRemoval(communities.gone);
  // A Person is never a community, even with a community's name.
  await seedActor(lemmy, 'Person', 'technology_fan');

  await seedFollow(member1!, communities.news);
  await seedFollow(member2!, communities.news);
  await seedFollow(member3!, communities.news);
  await seedFollow(viewer!, communities.news, 'pending');
  await seedFollow(member1!, communities.art);
  await seedFollow(viewer!, communities.technology);
  await seedFollow(member1!, communities.technology);
  await seedFollow(member2!, communities.technology, 'pending');

  const post = (community: { id: string }, author: { id: string }, ago: number, extra = {}) =>
    seedPost(community === communities.news || community === communities.art ? local : lemmy, community, author, {
      publishedAt: new Date(Date.now() - ago),
      ...extra,
    });
  await post(communities.news, member1!, day);
  await post(communities.news, member1!, 2 * day);
  await post(communities.news, member2!, 3 * day);
  await post(communities.news, member3!, 10 * day);
  await post(communities.news, member3!, day, { deletedAt: new Date() });
  await post(communities.news, member3!, day, { removedAt: new Date() });
  for (const author of authors) await post(communities.technology, author, 2 * day);
  await post(communities.technology, authors[0]!, 3 * day);
  return { instances: { local, lemmy, piefed }, people: { viewer: viewer!, minor: minor!, authors }, communities };
}

/**
 * What the e2e spec reads, made fresh each run (names carry a suffix, so the lane database may
 * keep earlier runs): a signed-in account that declared 16+ and one that has not, a local
 * community, a local NSFW one, a remote one, a remote NSFW one that must not list and a remote
 * person. Prints
 * the names as JSON.
 */
async function e2e() {
  const { seedAccount, PASSWORD } = await import('./seed-a.ts');
  const suffix = Math.random().toString(36).slice(2, 8);
  const instance = { ...(await localInstance(db())), domain: new URL((await localInstance(db())).origin).host, local: true };
  const remote = await seedInstance(`lemmy-${suffix}.test`, false);
  const [viewer, undeclared] = await Promise.all([seedAccount(`disc_${suffix}`), seedAccount(`disc_minor_${suffix}`)]);
  await writer().delete(ageDeclarations).where(eq(ageDeclarations.actorId, undeclared.actorId));
  const community = {
    local: await seedActor(instance, 'Group', `disc_local_${suffix}`, { summaryHtml: `<p>A place for ${suffix}</p>` }),
    adult: await seedActor(instance, 'Group', `disc_adult_${suffix}`, { sensitive: true }),
    remote: await seedActor(remote, 'Group', `disc_remote_${suffix}`, {
      apId: `https://${remote.domain}/c/disc_remote_${suffix}`,
      summaryHtml: `<p>Remote ${suffix}</p>`,
      fetchedAt: new Date(),
    }),
    remoteAdult: await seedActor(remote, 'Group', `disc_remote_adult_${suffix}`, { sensitive: true, fetchedAt: new Date() }),
  };
  const person = await seedActor(remote, 'Person', `disc_person_${suffix}`, {
    apId: `https://${remote.domain}/u/disc_person_${suffix}`,
    fetchedAt: new Date(),
  });
  return {
    password: PASSWORD,
    suffix,
    /** This server's own host, as handles write it: a lookup of it is never asked of the network. */
    localHost: instance.domain,
    viewer: { name: viewer.name },
    undeclared: { name: undeclared.name },
    host: remote.domain,
    communities: {
      local: community.local.name,
      adult: community.adult.name,
      remote: community.remote.name,
      remoteAdult: community.remoteAdult.name,
    },
    /** A remote person held here, whom a lookup sends to /u/<name>@<host>. */
    remotePerson: person.name,
  };
}

/**
 * A listed remote community whose name carries a right-to-left override, with the most
 * subscribers, so it heads the directory's default order (by subscribers) and every visit to
 * /communities draws one handle with the replacement mark (the payload budget's font check, which
 * e2e/payload/seed.ts runs this for). Made only when the community with the most subscribers is
 * not already one, so repeated runs add no more. Escapes only: no control character here.
 */
export async function seedBidiCommunityOnTop() {
  const [most] = await writer().execute<{ name: string; subscribers: number }>(
    sql`select actors.name, count(*)::int as subscribers from follows join actors on actors.id = follows.followee_id
        where follows.state = 'accepted' and actors.kind = 'Group' group by actors.id order by subscribers desc limit 1`,
  );
  if (most && /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/.test(most.name)) return;
  const suffix = Math.random().toString(36).slice(2, 8);
  const far = await seedInstance(`bidi-${suffix}.example`, false);
  const community = await seedActor(far, 'Group', `bidi\u202E${suffix}`);
  for (let i = 0; i <= (most?.subscribers ?? 0); i++) await seedFollow(await seedActor(far, 'Person', `fan_${suffix}_${i}`), community);
}

if (import.meta.main) {
  try {
    const [command] = process.argv.slice(2);
    if (command === 'e2e') console.log(JSON.stringify(await e2e()));
    else throw new Error('usage: node packages/core/src/testing/seed-disc.ts e2e');
  } finally {
    await closePools();
  }
}
