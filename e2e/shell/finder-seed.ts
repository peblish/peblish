import { closePools } from '../../packages/core/src/db/pools.ts';
import { db } from '../../packages/core/src/db/read.ts';
import { localInstance } from '../../packages/core/src/db/local-instance.ts';
import { outbox } from '../../packages/core/src/db/tables/outbox.ts';
import { PASSWORD, seedAccount } from '../../packages/core/src/testing/seed-a.ts';
import { seedFollow } from '../../packages/core/src/testing/seed-c1.ts';
import { seedActor, seedInstance } from '../../packages/core/src/testing/seed.ts';

// The finder's cast (e2e/shell/finder.spec.ts), on the lane database: `node e2e/shell/finder-seed.ts` prints it as
// JSON. One person who joined a local community and asked to join a remote one, and two communities they did not
// join, all named with one fresh word so a search for it finds exactly these four; the remote two live on one host,
// so a search for the host finds them alone. `node e2e/shell/finder-seed.ts outbox` prints the outbox's row count.

async function cast() {
  const word = `fnd${Math.random().toString(36).slice(2, 8)}`;
  const host = new URL((await localInstance(db())).origin).host;
  const local = { ...(await localInstance(db())), domain: host, local: true };
  const oven = await seedInstance(`oven-${word}.test`, false);
  const person = await seedAccount(`finder_${word}`);
  const brew = await seedActor(local, 'Group', `brew_${word}`, { displayName: `Brewing ${word}` });
  const bake = await seedActor(local, 'Group', `bake_${word}`, { displayName: `Baking ${word}` });
  const kiln = await seedActor(oven, 'Group', `kiln_${word}`, { displayName: `Kilns ${word}`, fetchedAt: new Date() });
  const glaze = await seedActor(oven, 'Group', `glaze_${word}`, { displayName: `Glazes ${word}`, fetchedAt: new Date() });
  await seedFollow({ id: person.actorId }, brew);
  await seedFollow({ id: person.actorId }, kiln, 'pending');
  return {
    password: PASSWORD,
    person: person.name,
    word,
    host: oven.domain,
    communities: {
      brew: { id: brew.id, handle: brew.name, title: `Brewing ${word}` },
      bake: { id: bake.id, handle: bake.name, title: `Baking ${word}` },
      kiln: { id: kiln.id, handle: `${kiln.name}@${oven.domain}`, title: `Kilns ${word}` },
      glaze: { id: glaze.id, handle: `${glaze.name}@${oven.domain}`, title: `Glazes ${word}` },
    },
  };
}

try {
  if (process.argv[2] === 'outbox') {
    console.log(JSON.stringify({ rows: await db().$count(outbox) }));
  } else console.log(JSON.stringify(await cast()));
} finally {
  await closePools();
}
