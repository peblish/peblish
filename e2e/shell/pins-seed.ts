import { localInstance } from '../../packages/core/src/db/local-instance.ts';
import { closePools } from '../../packages/core/src/db/pools.ts';
import { db } from '../../packages/core/src/db/read.ts';
import { writer } from '../../packages/core/src/db/write.ts';
import { peerControls } from '../../packages/core/src/peers/tables.ts';
import { communityPins } from '../../packages/core/src/pins/tables.ts';
import { PASSWORD, seedAccount } from '../../packages/core/src/testing/seed-a.ts';
import { seedFollow } from '../../packages/core/src/testing/seed-c1.ts';
import { seedActor, seedInstance } from '../../packages/core/src/testing/seed.ts';

// The pins specs' larger worlds, on the lane database, shaped as the pins seed's (packages/core/src/testing/
// seed-pins.ts): one person who follows Ash, Birch, Cedar, Damson and Elm here and asked to join Yew on another
// host, with Elm, Yew and Birch pinned in that order; Fir is not followed. Then, for `many`, 50 more local
// communities they follow, titled "Aa 00" to "Aa 49" so they sort before every other unpinned row and push the
// last of those past the sidebar's 50 rows; for `gated`, Oak, a sensitive local community they follow, pinned
// last, and Yew's host blocked by this server. `node e2e/shell/pins-seed.ts many|gated` prints it as JSON.

async function world(mode: string) {
  if (mode !== 'many' && mode !== 'gated') throw new Error(`unknown world ${mode}`);
  const suffix = Math.random().toString(36).slice(2, 8);
  const account = await seedAccount(`pins_${suffix}`);
  const person = { id: account.actorId };
  const instance = await localInstance(db());
  const local = { id: instance.id, domain: new URL(instance.origin).host, local: true };
  const far = await seedInstance(`pins-${suffix}.example`, false);
  const make = (name: string, title: string, on = local, extra = {}) =>
    seedActor(on, 'Group', `${name}_${suffix}`, { displayName: `${title} ${suffix}`, ...extra });
  const [ash, birch, cedar, damson, elm, fir, yew] = await Promise.all([
    make('ash', 'Ash'),
    make('birch', 'Birch'),
    make('cedar', 'Cedar'),
    make('damson', 'Damson'),
    make('elm', 'Elm'),
    make('fir', 'Fir'),
    make('yew', 'Yew', far),
  ]);
  for (const community of [ash!, birch!, cedar!, damson!, elm!]) await seedFollow(person, community);
  await seedFollow(person, yew!, 'pending');
  const pinned = [elm!, yew!, birch!];
  if (mode === 'many') {
    for (let index = 0; index < 50; index++) {
      const number = String(index).padStart(2, '0');
      await seedFollow(person, (await make(`aa${number}`, `Aa ${number}`))!);
    }
  } else {
    const oak = (await make('oak', 'Oak', local, { sensitive: true }))!;
    await seedFollow(person, oak);
    pinned.push(oak);
    await writer()
      .insert(peerControls)
      .values({ instanceId: far.id, blocked: true, reason: `Blocked ${suffix}` });
  }
  await writer()
    .insert(communityPins)
    .values(pinned.map((community, position) => ({ ownerId: person.id, communityId: community.id, position })));
  const ref = (actor: { id: string; name: string }) => ({ id: actor.id, name: actor.name });
  return {
    password: PASSWORD,
    name: account.name,
    suffix,
    host: far.domain,
    communities: Object.fromEntries(Object.entries({ ash, birch, cedar, damson, elm, fir, yew }).map(([key, actor]) => [key, ref(actor!)])),
  };
}

try {
  console.log(JSON.stringify(await world(process.argv[2] ?? '')));
} finally {
  await closePools();
}
