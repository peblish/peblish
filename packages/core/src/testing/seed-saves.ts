import { eq } from 'drizzle-orm';
import { closePools } from '../db/pools.ts';
import { db } from '../db/read.ts';
import { localInstance } from '../db/local-instance.ts';
import { posts as postsTable } from '../db/tables/content.ts';
import { writer } from '../db/write.ts';
import { savedPosts } from '../saves/tables.ts';
import { seedPost } from './seed-az.ts';
import { seedActor } from './seed.ts';

// The saves lane's e2e world (`node packages/core/src/testing/seed-saves.ts e2e`, on the lane database):
// two accounts, a community with 25 posts, of which the first account saved 21 at distinct times
// (two pages of 20) plus one that a moderator removed afterwards, and two the spec saves itself. Test code only.

async function e2e() {
  const { seedAccount, PASSWORD } = await import('./seed-a.ts');
  const suffix = Math.random().toString(36).slice(2, 8);
  const local = await localInstance(db());
  const instance = { ...local, domain: new URL(local.origin).host, local: true };
  const [owner, other] = await Promise.all([seedAccount(`saver_${suffix}`), seedAccount(`other_${suffix}`)]);
  const author = await seedActor(instance, 'Person', `saves_author_${suffix}`);
  const community = await seedActor(instance, 'Group', `saves_${suffix}`);
  const at = Date.now() - 3_600_000;
  const posts: string[] = [];
  for (let n = 1; n <= 25; n += 1)
    posts.push(
      (
        await seedPost(instance, community, author, {
          title: `Saved ${suffix} ${String(n).padStart(2, '0')}`,
          // The newest posts on the server, in order, so they lead the All feed sorted by New.
          publishedAt: new Date(Date.now() - (26 - n) * 1000),
        })
      ).id,
    );
  // Saved 01 is the oldest save, Saved 21 the newest; Saved 22 is saved and then removed by a moderator.
  for (const [i, postId] of posts.slice(0, 22).entries())
    await writer()
      .insert(savedPosts)
      .values({ ownerId: owner.actorId, postId, savedAt: new Date(at + i * 60_000) });
  const removed = posts[21]!;
  await writer().update(postsTable).set({ removedAt: new Date() }).where(eq(postsTable.id, removed));
  return {
    password: PASSWORD,
    suffix,
    owner: owner.name,
    other: other.name,
    community: community.name,
    posts: { saved: posts.slice(0, 21), removed, unsaved: posts.slice(22) },
  };
}

if (import.meta.main) {
  try {
    const [command] = process.argv.slice(2);
    if (command === 'e2e') console.log(JSON.stringify(await e2e()));
    else throw new Error('usage: node packages/core/src/testing/seed-saves.ts e2e');
  } finally {
    await closePools();
  }
}
