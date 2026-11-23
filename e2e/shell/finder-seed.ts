import { communityBlocks, instanceBlocks } from '../../packages/core/src/blocks/tables.ts';
import { closePools } from '../../packages/core/src/db/pools.ts';
import { db } from '../../packages/core/src/db/read.ts';
import { localInstance } from '../../packages/core/src/db/local-instance.ts';
import { outbox } from '../../packages/core/src/db/tables/outbox.ts';
import { writer } from '../../packages/core/src/db/write.ts';
import { peerControls } from '../../packages/core/src/peers/tables.ts';
import { PASSWORD, seedAccount } from '../../packages/core/src/testing/seed-a.ts';
import { seedCommunityRemoval } from '../../packages/core/src/testing/seed-az.ts';
import { seedFollow } from '../../packages/core/src/testing/seed-c1.ts';
import { seedActor, seedInstance } from '../../packages/core/src/testing/seed.ts';

// The finder's cast (e2e/shell/finder.spec.ts), on the lane database: `node e2e/shell/finder-seed.ts` prints it as
// JSON. One person who joined a local community and asked to join a remote one, and two communities they did not
// join, all named with one fresh word so a search for it finds exactly these four; the remote two live on one host,
// so a search for the host finds them alone. `node e2e/shell/finder-seed.ts outbox` prints the outbox's row count.
//
// `hidden`, under a second word: communities the same person follows that the server must keep out of the finder
// (age-gated for a person who declared no age, on a blocked host, blocked by the person, on an instance the person
// blocked, and one removed once the page has loaded: `node e2e/shell/finder-seed.ts remove <id>`), two it must keep
// (one joined, one asked to join), and 26 remote ones with a follower each, which fill the directory's first page
// for the word ahead of those two.

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

  const other = `hid${Math.random().toString(36).slice(2, 8)}`;
  const far = await seedInstance(`far-${other}.test`, false);
  const wall = await seedInstance(`wall-${other}.test`, false);
  const shun = await seedInstance(`shun-${other}.test`, false);
  const crowdHost = await seedInstance(`crowd-${other}.test`, false);
  await writer().insert(peerControls).values({ instanceId: wall.id, blocked: true });
  await writer().insert(instanceBlocks).values({ blockerId: person.actorId, instanceId: shun.id });
  const group = (instance: Parameters<typeof seedActor>[0], name: string, extra: Parameters<typeof seedActor>[3] = {}) =>
    seedActor(instance, 'Group', `${name}_${other}`, { displayName: `${name} ${other}`, ...extra });
  const shown = await group(local, 'shown');
  const asked = await group(far, 'asked', { fetchedAt: new Date() });
  const adult = await group(local, 'adult', { sensitive: true });
  const walled = await group(wall, 'walled', { fetchedAt: new Date() });
  const muted = await group(local, 'muted');
  const shunned = await group(shun, 'shunned', { fetchedAt: new Date() });
  const fading = await group(local, 'fading');
  for (const community of [shown, adult, walled, muted, shunned, fading]) await seedFollow({ id: person.actorId }, community);
  await seedFollow({ id: person.actorId }, asked, 'pending');
  await writer().insert(communityBlocks).values({ blockerId: person.actorId, communityId: muted.id });
  const crowd = await seedAccount(`crowd_${other}`);
  for (let index = 0; index < 26; index++) {
    const member = await group(crowdHost, `a${String(index).padStart(2, '0')}`, { fetchedAt: new Date() });
    await seedFollow({ id: crowd.actorId }, member);
  }
  const ref = (actor: { id: string; name: string; displayName: string | null }, host?: string) => ({
    id: actor.id,
    handle: host ? `${actor.name}@${host}` : actor.name,
    title: actor.displayName!,
  });
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
    hidden: {
      word: other,
      shown: ref(shown),
      asked: ref(asked, far.domain),
      adult: ref(adult),
      walled: ref(walled, wall.domain),
      muted: ref(muted),
      shunned: ref(shunned, shun.domain),
      fading: ref(fading),
    },
  };
}

try {
  if (process.argv[2] === 'outbox') {
    console.log(JSON.stringify({ rows: await db().$count(outbox) }));
  } else if (process.argv[2] === 'remove') {
    await seedCommunityRemoval({ id: process.argv[3]! });
    console.log('{}');
  } else console.log(JSON.stringify(await cast()));
} finally {
  await closePools();
}
