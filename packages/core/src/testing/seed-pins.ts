import { eq } from 'drizzle-orm';
import { closePools } from '../db/pools.ts';
import { db } from '../db/read.ts';
import { instances } from '../db/tables/instances.ts';
import { writer } from '../db/write.ts';
import { communityPins } from '../pins/tables.ts';
import { PASSWORD, seedAccount } from './seed-a.ts';
import { seedActor, seedInstance } from './seed.ts';
import { seedFollow } from './seed-c1.ts';

// The pins lane's browser specs' world on the lane database (DATABASE_URL from scripts/lane.sh): one
// person who follows five local communities and asked to join a remote one, three of them pinned (the
// remote pending one among them), plus a local community they do not follow. Fresh names every run, so
// the lane database keeps earlier runs. `node packages/core/src/testing/seed-pins.ts e2e` prints it as
// JSON. Test code only.
export async function seedPinsWorld() {
  const suffix = Math.random().toString(36).slice(2, 8);
  const account = await seedAccount(`pins_${suffix}`);
  const [local] = await db().select().from(instances).where(eq(instances.local, true));
  if (!local) throw new Error('the lane database has no local instance');
  const far = await seedInstance(`pins-${suffix}.example`, false);
  const make = (name: string, title: string, instance = local) => seedActor(instance, 'Group', `${name}_${suffix}`, { displayName: title });
  const [ash, birch, cedar, damson, elm, fir, remote] = await Promise.all([
    make('ash', `Ash ${suffix}`),
    make('birch', `Birch ${suffix}`),
    make('cedar', `Cedar ${suffix}`),
    make('damson', `Damson ${suffix}`),
    make('elm', `Elm ${suffix}`),
    make('fir', `Fir ${suffix}`),
    make('yew', `Yew ${suffix}`, far),
  ]);
  for (const community of [ash!, birch!, cedar!, damson!, elm!]) await seedFollow({ id: account.actorId }, community);
  await seedFollow({ id: account.actorId }, remote!, 'pending');
  // Pinned: Elm, then the pending Yew, then Birch.
  await writer()
    .insert(communityPins)
    .values([elm!, remote!, birch!].map((community, position) => ({ ownerId: account.actorId, communityId: community.id, position })));
  const ref = (actor: { id: string; name: string; displayName?: string | null }) => ({
    id: actor.id,
    name: actor.name,
    title: actor.displayName,
  });
  return {
    password: PASSWORD,
    name: account.name,
    suffix,
    host: far.domain,
    communities: {
      ash: ref(ash!),
      birch: ref(birch!),
      cedar: ref(cedar!),
      damson: ref(damson!),
      elm: ref(elm!),
      fir: ref(fir!),
      yew: ref(remote!),
    },
  };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await seedPinsWorld()));
  } finally {
    await closePools();
  }
}
