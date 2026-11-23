import { and, eq } from 'drizzle-orm';
import { closePools } from '../db/pools.ts';
import { db } from '../db/read.ts';
import { writer } from '../db/write.ts';
import { threadVisits } from '../visits/tables.ts';
import { seedComment, seedPost } from './seed-az.ts';
import { seedActor } from './seed.ts';

// Lane f-visits' seeds for e2e/post/new-since.spec.ts: a reader who visited one thread two hours
// ago (comments arrived since, one theirs, one removed) and has never opened two others. Every run
// uses fresh names, so the lane database keeps earlier runs. Test code only.

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

async function e2e() {
  const { seedAccount: seedLogin, PASSWORD } = await import('./seed-a.ts');
  const { localInstance } = await import('../db/local-instance.ts');
  const suffix = Math.random().toString(36).slice(2, 8);
  const origin = (await localInstance(db())).origin;
  const instance = { ...(await localInstance(db())), domain: new URL(origin).host, local: true };
  const [reader, author] = await Promise.all([seedLogin(`reader_${suffix}`), seedLogin(`author_${suffix}`)]);
  if (!reader || !author) throw new Error('accounts');
  const community = await seedActor(instance, 'Group', `visits_${suffix}`);
  const by = (account: { actorId: string }) => ({ id: account.actorId });
  const body = (text: string) => ({ bodyMd: text, contentHtml: `<p>${text}</p>` });

  const seen = await seedPost(instance, community, by(author), { title: `Visited thread ${suffix}` });
  const old = await seedComment(instance, seen, by(author), { createdAt: ago(180), ...body(`Before the visit ${suffix}`) });
  await writer()
    .insert(threadVisits)
    .values({ ownerId: reader.actorId, postId: seen.id, lastVisitAt: ago(120) });
  const first = await seedComment(instance, seen, by(author), { createdAt: ago(60), ...body(`Arrived first ${suffix}`) });
  const own = await seedComment(instance, seen, by(reader), { createdAt: ago(40), ...body(`The reader's own ${suffix}`) });
  const second = await seedComment(instance, seen, by(author), { createdAt: ago(30), ...body(`Arrived second ${suffix}`) });
  const removed = await seedComment(instance, seen, by(author), { createdAt: ago(20), removedAt: ago(10), ...body(`Removed ${suffix}`) });

  const unseen = await seedPost(instance, community, by(author), { title: `Unvisited thread ${suffix}` });
  const waiting = await seedComment(instance, unseen, by(author), { createdAt: ago(30), ...body(`Waiting ${suffix}`) });
  // Only ever read without a page on screen (a HEAD, a plain GET, scripts off), so it never gets a marker.
  const untouched = await seedPost(instance, community, by(author), { title: `Untouched thread ${suffix}` });
  await seedComment(instance, untouched, by(author), body(`Untouched ${suffix}`));

  return {
    password: PASSWORD,
    reader: { name: reader.name, actorId: reader.actorId },
    posts: { seen: seen.id, unseen: unseen.id, untouched: untouched.id },
    comments: { old: old.id, first: first.id, own: own.id, second: second.id, removed: removed.id, waiting: waiting.id },
  };
}

/** The reader's marker on a thread, or null: what a spec checks after a request that must not record. */
async function marker(ownerId: string, postId: string) {
  const [row] = await db()
    .select()
    .from(threadVisits)
    .where(and(eq(threadVisits.ownerId, ownerId), eq(threadVisits.postId, postId)));
  return row ?? null;
}

if (import.meta.main) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'e2e') console.log(JSON.stringify(await e2e()));
    else if (command === 'marker' && args[0] && args[1]) console.log(JSON.stringify(await marker(args[0], args[1])));
    else throw new Error('usage: node packages/core/src/testing/seed-visits.ts e2e | marker <ownerId> <postId>');
  } finally {
    await closePools();
  }
}
