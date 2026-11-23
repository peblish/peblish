import { eq, inArray, sql } from 'drizzle-orm';
import { ageDeclarations } from '../identity/tables.ts';
import { uuidv7 } from 'uuidv7';
import { closePools } from '../db/pools.ts';
import { posts } from '../db/tables/content.ts';
import { peerControls } from '../peers/tables.ts';
import { writer } from '../db/write.ts';
import { PASSWORD, seedAccount } from './seed-a.ts';
import { seedFollow } from './seed-c1.ts';
import { seedActor, seedInstance } from './seed.ts';

// A deep feed for the feed specs of the place in the address (`n`, e2e/feeds), on the lane database (DATABASE_URL
// from scripts/lane.sh). `node packages/core/src/testing/seed-depth.ts` prints a person whose Subscribed feed is one remote
// community of 220 posts, `Depth <suffix> 001` the newest. The posts are two years old: the oldest in All, and
// at the end of every other feed, so no other spec's first pages change. The person has not declared 16+, so
// a post marked sensitive is withheld from them. Fresh names every run. The other commands change a post, by
// its title, as another person or a moderator would while the reader is away: `remove <title>`,
// `restore <title>`, `swap <title> <title>` (their publication times) and `sensitive <title> <true|false>`; and
// `arrive <suffix> <count>` publishes that many newer posts in the run's community (`Depth <suffix> new 01` …, still
// two years old, so they lead only that community's feeds), which `depart <suffix>` removes again. `picture <true|false>
// <title>…` makes posts image posts, or text posts again; each picture is on this instance
// (`/depth-pictures/<id>.png` under PUBLIC_ORIGIN), so the page loads it from its own host and a spec answers for it,
// and the run's peer has its media approved for that, as a moderator would. `link <title> [url]` makes a post a
// link to `url`, or a text post again without one.
const [command, ...ids] = process.argv.slice(2);
try {
  if (command === 'remove' || command === 'restore')
    await writer()
      .update(posts)
      .set({ removedAt: command === 'remove' ? new Date() : null })
      .where(eq(posts.title, ids[0]!));
  else if (command === 'sensitive')
    await writer()
      .update(posts)
      .set({ sensitive: ids[1] === 'true' })
      .where(eq(posts.title, ids[0]!));
  else if (command === 'link')
    await writer()
      .update(posts)
      .set({ url: ids[1] ?? null, urlContentType: null })
      .where(eq(posts.title, ids[0]!));
  else if (command === 'picture') {
    const [on, ...titles] = ids;
    const found = await writer().select({ id: posts.id, instanceId: posts.instanceId }).from(posts).where(inArray(posts.title, titles));
    for (const instanceId of new Set(on === 'true' ? found.map((post) => post.instanceId) : []))
      await writer()
        .insert(peerControls)
        .values({ instanceId, media: 'approved' })
        .onConflictDoUpdate({ target: peerControls.instanceId, set: { media: 'approved' } });
    for (const { id } of found)
      await writer()
        .update(posts)
        .set(
          on === 'true'
            ? { url: new URL(`/depth-pictures/${id}.png`, process.env.PUBLIC_ORIGIN).href, urlContentType: 'image/png' }
            : { url: null, urlContentType: null },
        )
        .where(eq(posts.id, id));
  } else if (command === 'arrive') {
    const [suffix, count] = ids;
    const [found] = await writer()
      .select({
        instanceId: posts.instanceId,
        authorId: posts.authorId,
        communityId: posts.communityId,
        publishedAt: posts.publishedAt,
        apId: posts.apId,
      })
      .from(posts)
      .where(eq(posts.title, `Depth ${suffix} 001`));
    const { apId, ...first } = found!;
    const domain = new URL(apId).host;
    await writer()
      .insert(posts)
      .values(
        Array.from({ length: Number(count) }, (_, index) => {
          const id = uuidv7();
          return {
            ...first,
            id,
            apId: `https://${domain}/ap/post/${id}`,
            local: false,
            title: `Depth ${suffix} new ${String(index + 1).padStart(2, '0')}`,
            publishedAt: new Date(first.publishedAt.getTime() + (index + 1) * 1000),
          };
        }),
      );
  } else if (command === 'depart')
    await writer()
      .update(posts)
      .set({ removedAt: new Date() })
      .where(sql`${posts.title} like ${`Depth ${ids[0]} new %`}`);
  else if (command === 'swap') {
    const rows = await writer()
      .select({ id: posts.id, title: posts.title, publishedAt: posts.publishedAt })
      .from(posts)
      .where(inArray(posts.title, ids));
    const [one, other] = ids.map((title) => rows.find((row) => row.title === title)!);
    await writer().transaction(async (tx) => {
      await tx.update(posts).set({ publishedAt: other!.publishedAt }).where(eq(posts.id, one!.id));
      await tx.update(posts).set({ publishedAt: one!.publishedAt }).where(eq(posts.id, other!.id));
    });
  } else {
    const suffix = Math.random().toString(36).slice(2, 8);
    const far = await seedInstance(`depth-${suffix}.example`, false);
    const [reader, community, author] = await Promise.all([
      seedAccount(`depth_${suffix}`),
      seedActor(far, 'Group', `depth_${suffix}`),
      seedActor(far, 'Person', `depth_author_${suffix}`),
    ]);
    await seedFollow({ id: reader.actorId }, community);
    await writer().delete(ageDeclarations).where(eq(ageDeclarations.actorId, reader.actorId));
    const old = 2 * 365 * 24 * 3_600_000;
    const rows = Array.from({ length: 220 }, (_, index) => {
      const id = uuidv7();
      return {
        id,
        apId: `https://${far.domain}/ap/post/${id}`,
        local: false,
        instanceId: far.id,
        authorId: author.id,
        communityId: community.id,
        title: `Depth ${suffix} ${String(index + 1).padStart(3, '0')}`,
        publishedAt: new Date(Date.now() - old - index * 60_000),
      };
    });
    await writer().insert(posts).values(rows);
    // Earlier runs' depth posts leave every feed.
    await writer().execute(
      sql`update posts set removed_at = now() where removed_at is null and title ~ '^Depth [a-z0-9]{6} ' and title !~ ${`^Depth ${suffix} `}`,
    );
    console.log(JSON.stringify({ password: PASSWORD, name: reader.name, suffix }));
  }
} finally {
  await closePools();
}
