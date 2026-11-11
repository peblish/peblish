import { closePools } from '../../packages/core/src/db/pools.ts';
import { db } from '../../packages/core/src/db/read.ts';
import { localInstance } from '../../packages/core/src/db/local-instance.ts';
import { PASSWORD, seedAccount } from '../../packages/core/src/testing/seed-a.ts';
import { seedPost } from '../../packages/core/src/testing/seed-az.ts';
import { drainNotices, remoteSay, say } from '../../packages/core/src/testing/seed-e2.ts';
import { seedActor, seedInstance } from '../../packages/core/src/testing/seed.ts';

// The inbox review cases, on the lane database (DATABASE_URL from scripts/lane.sh):
// `node e2e/notifications/seed.ts` prints the cast as JSON, on fresh names every run. `reader`
// has three unread replies, each from someone else on a different post: one from a remote person
// with a long name on a long host, under a long title, and two from local people. With `hostile`,
// a fresh `hostileReader` also has one reply from a remote person whose username, and the title of
// whose post, carry a right-to-left override (`hostile.handle`, `hostile.title`). Escapes only:
// this file holds no control character.
try {
  const suffix = Math.random().toString(36).slice(2, 8);
  const host = new URL((await localInstance(db())).origin).host;
  const local = { ...(await localInstance(db())), domain: host, local: true };
  const far = await seedInstance(`a-very-long-subdomain-${suffix}.some-instance.example`, false);
  const long = await seedActor(far, 'Person', `a_very_long_account_name_${suffix}`);
  const [reader, ada, cy] = await Promise.all(['reader', 'ada', 'cy'].map((role) => seedAccount(`e2n${role}_${suffix}`)));
  const community = await seedActor(local, 'Group', `e2nc_${suffix}`);
  const mine = { id: reader!.actorId };
  const titles = {
    long: `A remarkably long post title that keeps going well past the width of a narrow phone ${suffix}`,
    ada: `Ada's question ${suffix}`,
    cy: `Cy's question ${suffix}`,
  };
  const longPost = await seedPost(local, community, mine, { title: titles.long, bodyMd: 'Body' });
  const adaPost = await seedPost(local, community, mine, { title: titles.ada, bodyMd: 'Body' });
  const cyPost = await seedPost(local, community, mine, { title: titles.cy, bodyMd: 'Body' });
  await remoteSay(long, longPost.apId);
  await say({ id: ada!.actorId }, adaPost.id, `Hello from Ada ${suffix}`);
  await say({ id: cy!.actorId }, cyPost.id, `Hello from Cy ${suffix}`);
  let hostile: { reader: string; handle: string; title: string } | undefined;
  if (process.argv[2] === 'hostile') {
    const reader = await seedAccount(`e2nhostile_${suffix}`);
    const evil = await seedActor(far, 'Person', `evil_${suffix}\u202Eesrever`);
    const title = `Reversed \u202Eeltit ${suffix}`;
    const post = await seedPost(local, community, { id: reader.actorId }, { title, bodyMd: 'Body' });
    await remoteSay(evil, post.apId);
    hostile = { reader: reader.name, handle: `${evil.name}@${far.domain}`, title };
  }
  await drainNotices();
  console.log(
    JSON.stringify({
      password: PASSWORD,
      reader: { name: reader!.name },
      long: { handle: `${long.name}@${far.domain}`, name: long.name, host: far.domain },
      ada: { name: ada!.name },
      cy: { name: cy!.name },
      titles,
      ...(hostile && { hostile }),
    }),
  );
} finally {
  await closePools();
}
