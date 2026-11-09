import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { closePools } from '../db/pools.ts';
import { db } from '../db/read.ts';
import { localInstance } from '../db/local-instance.ts';
import { posts } from '../db/tables/content.ts';
import { follows } from '../db/tables/follows.ts';
import { writer } from '../db/write.ts';
import { ageDeclarations } from '../identity/tables.ts';
import { seedModerator, seedPost } from './seed-az.ts';
import { seedPerson } from './seed-f.ts';
import { seedActor, seedInstance } from './seed.ts';

// Lane C1's seeds: a small world for the feed tests, and a large one for the performance
// target (100,000 posts over 90 days in 300 communities, a viewer following 130). Test code only.

type Instance = { id: string; domain: string; local: boolean };
type Row = { id: string };

/** An accepted follow, as the community's Accept leaves it. */
export async function seedFollow(follower: Row, community: Row, state: 'accepted' | 'pending' = 'accepted') {
  await writer()
    .insert(follows)
    .values({ followerId: follower.id, followeeId: community.id, state, acceptedAt: state === 'accepted' ? new Date() : null });
}

/** A post `ago` milliseconds old, with a score of `votes.up - votes.down`. */
export async function seedFeedPost(
  instance: Instance,
  community: Row,
  author: Row,
  { ago = 60_000, up = 0, down = 0, ...extra }: { ago?: number; up?: number; down?: number } & Partial<typeof posts.$inferInsert> = {},
) {
  return seedPost(instance, community, author, { publishedAt: new Date(Date.now() - ago), upvotes: up, downvotes: down, ...extra });
}

/**
 * The cast of the feed tests, on the local instance `feddit.test` and a remote one:
 * - `viewer`, a person with a 16+ declaration who follows `news` (accepted), `remoteTech`
 *   (accepted) and `pending` (not yet accepted), and moderates `news`; `stranger` follows nothing;
 * - local communities `news` and `art`, a sensitive one `adult`; remote communities
 *   `remoteTech`, `pending` and a removed one `gone`; `deleted` is a deleted community.
 * No posts: each test adds its own.
 */
export async function seedFeedWorld() {
  const local = await seedInstance('feddit.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const people = {
    viewer: await seedPerson(local, 'viewer'),
    stranger: await seedPerson(local, 'stranger'),
    author: await seedActor(local, 'Person', 'author'),
    remoteAuthor: await seedActor(lemmy, 'Person', 'remote_author'),
  };
  const communities = {
    news: await seedActor(local, 'Group', 'news'),
    art: await seedActor(local, 'Group', 'art'),
    adult: await seedActor(local, 'Group', 'adult', { sensitive: true }),
    remoteTech: await seedActor(lemmy, 'Group', 'technology'),
    pending: await seedActor(lemmy, 'Group', 'pending'),
    gone: await seedActor(lemmy, 'Group', 'gone'),
    deleted: await seedActor(lemmy, 'Group', 'deleted', { deletedAt: new Date() }),
  };
  const { seedCommunityRemoval } = await import('./seed-az.ts');
  await seedCommunityRemoval(communities.gone);
  await writer().insert(ageDeclarations).values({ actorId: people.viewer.id });
  await seedFollow(people.viewer, communities.news);
  await seedFollow(people.viewer, communities.remoteTech);
  await seedFollow(people.viewer, communities.pending, 'pending');
  await seedModerator(communities.news, people.viewer);
  return { instances: { local, lemmy }, people, communities };
}

export type BulkOptions = {
  posts?: number;
  days?: number;
  communities?: number;
  /** Communities the busy viewer follows. */
  followed?: number;
  /** Every 30th community (so 10 of 300) is local, and local posts weigh as much as any. */
  local: Instance;
};

/**
 * The performance world: `communities` Groups (a tenth of them local, the rest on 40 remote
 * instances) with a skewed share of `posts` published over `days` days, 2,000 remote and 50
 * local authors, a long tail of scores, 1% deleted, 1% removed and 1.5% sensitive.
 * People: `busy` follows `followed` remote communities and moderates two; `sparse` follows
 * the three quietest; `moderator` moderates the two busiest local ones. Returns their ids.
 */
export async function seedBulk({ posts: postCount = 100_000, days = 90, communities = 300, followed = 130, local }: BulkOptions) {
  const w = writer();
  await w.execute(sql`select setseed(0.314)`);
  await w.execute(sql`
    insert into instances (id, domain, origin, local, software)
    select gen_random_uuid(), 'r' || s.i || '.test', 'https://r' || s.i || '.test', false, 'lemmy' from generate_series(1, 40) as s(i)`);
  await w.execute(sql`
    with remote as (select id, domain, row_number() over (order by domain) as n from instances where not local),
         numbered as (
           select s.i, case when s.i % 30 = 0 then ${local.id}::uuid else (select id from remote where remote.n = 1 + s.i % 40) end as instance_id,
                  case when s.i % 30 = 0 then ${local.domain} else (select domain from remote where remote.n = 1 + s.i % 40) end as domain,
                  s.i % 30 = 0 as is_local
           from generate_series(1, ${communities}::int) as s(i))
    insert into actors (id, ap_id, kind, local, instance_id, name)
    select gen_random_uuid(), 'https://' || domain || '/c/c' || i, 'Group', is_local, instance_id, 'c' || i from numbered`);
  await w.execute(sql`
    with remote as (select id, domain, row_number() over (order by domain) as n from instances where not local)
    insert into actors (id, ap_id, kind, local, instance_id, name)
    select gen_random_uuid(), 'https://' || r.domain || '/u/u' || s.i, 'Person', false, r.id, 'u' || s.i
    from generate_series(1, 2000) as s(i) join remote r on r.n = 1 + s.i % 40`);
  await w.execute(sql`
    insert into actors (id, ap_id, kind, local, instance_id, name)
    select gen_random_uuid(), 'https://' || ${local.domain} || '/u/l' || s.i, 'Person', true, ${local.id}::uuid, 'l' || s.i from generate_series(1, 50) as s(i)`);
  await w.execute(sql`
    with groups as (select id, row_number() over (order by substring(name from 2)::int) as n from actors where kind = 'Group' and name ~ '^c[0-9]+$'),
         people as (
           select a.id, a.local, a.instance_id, i.domain, row_number() over (order by a.ap_id) as n
           from actors a join instances i on i.id = a.instance_id where a.kind = 'Person' and a.name ~ '^[ul][0-9]+$'),
         total as (select count(*)::int as n from people),
         drawn as (
           select i, 1 + floor(${communities}::int * power(random(), 1.6))::int as g, 1 + floor(random() * (select n from total))::int as p,
                  now() - random() * ${days}::int * interval '1 day' as at,
                  floor(power(random(), 5) * 600)::int as up, floor(power(random(), 7) * 80)::int as down, random() as dice
           from generate_series(1, ${postCount}::int) i)
    insert into posts (id, ap_id, local, instance_id, author_id, community_id, title, url, body_md, content_html, sensitive,
                       upvotes, downvotes, comment_count, published_at, deleted_at, removed_at)
    select gen_random_uuid(), 'https://' || p.domain || '/post/' || d.i, p.local, p.instance_id, p.id, g.id,
           'Post number ' || d.i || ' about ' || md5(d.i::text),
           case when d.dice < 0.4 then 'https://example.test/a/' || d.i end,
           case when p.local and d.dice > 0.5 then repeat('A paragraph of **markdown** with a [link](https://example.test) in it. ', 6) end,
           case when not p.local and d.dice > 0.5 then repeat('<p>A paragraph of <b>remote</b> HTML with a <a href="https://example.test">link</a> in it.</p>', 6) end,
           d.dice > 0.985, d.up, d.down, floor(power(random(), 4) * 200)::int, d.at,
           case when random() < 0.01 then now() end, case when random() < 0.01 then now() end
    from drawn d join groups g on g.n = d.g join people p on p.n = d.p`);

  const heavy = await seedPerson({ id: local.id, domain: local.domain, local: true }, `busy_${uuidv7().slice(-6)}`);
  const sparse = await seedPerson({ id: local.id, domain: local.domain, local: true }, `sparse_${uuidv7().slice(-6)}`);
  const moderator = await seedPerson({ id: local.id, domain: local.domain, local: true }, `mod_${uuidv7().slice(-6)}`);
  for (const person of [heavy, sparse, moderator]) await writer().insert(ageDeclarations).values({ actorId: person.id });
  await w.execute(sql`
    insert into follows (id, follower_id, followee_id, state, accepted_at)
    select gen_random_uuid(), ${heavy.id}::uuid, id, 'accepted', now() from actors
    where kind = 'Group' and not local order by md5(id::text) limit ${followed}`);
  await w.execute(sql`
    insert into follows (id, follower_id, followee_id, state, accepted_at)
    select gen_random_uuid(), ${sparse.id}::uuid, c.id, 'accepted', now()
    from actors c where c.kind = 'Group' and not c.local order by (select count(*) from posts where community_id = c.id), c.id limit 3`);
  await w.execute(sql`
    insert into community_moderators (community_id, moderator_id, role, source, verified_at)
    select id, ${moderator.id}::uuid, 'moderator', 'local', now() from actors where kind = 'Group' and local
    order by (select count(*) from posts where community_id = actors.id) desc limit 2`);
  await w.execute(sql`analyze`);
  return { heavy, sparse, moderator };
}

/** Prints the ids the e2e feed spec needs; run on the lane database (`node seed-c1.ts e2e`). */
async function e2e() {
  const { seedAccount, PASSWORD } = await import('./seed-a.ts');
  const suffix = Math.random().toString(36).slice(2, 8);
  const instance = { ...(await localInstance(db())), domain: new URL((await localInstance(db())).origin).host, local: true };
  const remote = await seedInstance(`lemmy-${suffix}.test`, false);
  const [viewer, undeclared] = await Promise.all([seedAccount(`feeds_${suffix}`), seedAccount(`minor_${suffix}`)]);
  await writer().delete(ageDeclarations).where(eq(ageDeclarations.actorId, undeclared.actorId));
  // Earlier runs' posts leave every feed, so this run's scores and ranks are the top of each.
  await writer().execute(
    sql`update posts set removed_at = now() where removed_at is null and title ~ '^(Followed|Picture|Sensitive|Local|Other|Unloved) [a-z0-9]{6}( |$)'`,
  );
  const author = await seedActor(instance, 'Person', `feeds_author_${suffix}`);
  const community = {
    local: await seedActor(instance, 'Group', `feeds_local_${suffix}`),
    remote: await seedActor(remote, 'Group', `feeds_remote_${suffix}`),
    other: await seedActor(remote, 'Group', `feeds_other_${suffix}`),
    adult: await seedActor(instance, 'Group', `feeds_adult_${suffix}`, { sensitive: true }),
  };
  await seedFollow({ id: viewer.actorId }, community.remote);
  await seedModerator(community.local, { id: viewer.actorId });
  // Distinct, ordered ages so the feeds read the same on every run: the titles carry their rank.
  const make = async (community: Row, title: string, ago: number, extra: Parameters<typeof seedFeedPost>[3] = {}) =>
    (await seedFeedPost(instance, community, author, { ago, title, ...extra })).id;
  const posts: Record<string, string> = {};
  // 45 posts in the followed remote community, and one more below: enough for three pages of 20.
  for (let n = 1; n <= 45; n += 1)
    posts[`followed${n}`] = await make(community.remote, `Followed ${suffix} ${String(n).padStart(2, '0')}`, n * 60_000, {
      up: 100 - n,
      ...(n === 1
        ? { bodyMd: `Excerpt body ${suffix}`, contentHtml: `<p>Excerpt body ${suffix}</p>`, url: 'https://example.test/linked' }
        : {}),
    });
  posts.local = await make(community.local, `Local ${suffix}`, 30_000, { up: 5 });
  posts.other = await make(community.other, `Other ${suffix}`, 20_000, { up: 3 });
  posts.sensitive = await make(community.adult, `Sensitive ${suffix}`, 10_000, { up: 500, sensitive: true });
  posts.zero = await make(community.other, `Unloved ${suffix}`, 5_000);
  // The newest and the best-scored post: first in every sort of the followed feed. Its picture is on a remote host.
  posts.thumb = await make(community.remote, `Picture ${suffix}`, 1_000, {
    up: 600,
    thumbnailUrl: `https://images.example.test/${suffix}.png`,
    url: `https://images.example.test/${suffix}.html`,
  });
  return {
    password: PASSWORD,
    suffix,
    viewer: { name: viewer.name },
    undeclared: { name: undeclared.name },
    communities: { local: community.local.name, remote: community.remote.name },
    posts,
  };
}

if (import.meta.main) {
  try {
    const [command] = process.argv.slice(2);
    if (command === 'e2e') console.log(JSON.stringify(await e2e()));
    else if (command === 'bulk') {
      const local = await localInstance(db());
      const people = await seedBulk({ local: { ...local, domain: new URL(local.origin).host, local: true } });
      console.log(JSON.stringify(Object.fromEntries(Object.entries(people).map(([role, { id, name }]) => [role, { id, name }])), null, 2));
    } else throw new Error('usage: node packages/core/src/testing/seed-c1.ts e2e | bulk');
  } finally {
    await closePools();
  }
}
