import { communityRules } from '../../packages/core/src/communities/tables.ts';
import { closePools } from '../../packages/core/src/db/pools.ts';
import { db } from '../../packages/core/src/db/read.ts';
import { localInstance } from '../../packages/core/src/db/local-instance.ts';
import { follows } from '../../packages/core/src/db/tables/follows.ts';
import { siteSettings } from '../../packages/core/src/db/tables/site.ts';
import { writer } from '../../packages/core/src/db/write.ts';
import { s3Store } from '../../packages/core/src/storage/s3.ts';
import { PASSWORD, seedAccount } from '../../packages/core/src/testing/seed-a.ts';
import { seedBan, seedModerator } from '../../packages/core/src/testing/seed-az.ts';
import { seedActor, seedInstance } from '../../packages/core/src/testing/seed.ts';

// What e2e/composer runs against, on the lane database (DATABASE_URL from scripts/lane.sh):
// `node e2e/composer/seed.ts` prints the cast as JSON. Every run uses fresh names, so the lane
// database can keep earlier runs. `node e2e/composer/seed.ts uploads on|off` flips the switch.

async function world() {
  const suffix = Math.random().toString(36).slice(2, 8);
  const host = new URL((await localInstance(db())).origin).host;
  const local = { ...(await localInstance(db())), domain: host, local: true };
  const lemmy = await seedInstance(`lemmy-${suffix}.test`, false);
  const [poster, unverified, moderator, banned] = await Promise.all([
    seedAccount(`poster_${suffix}`),
    seedAccount(`unverified_${suffix}`, { emailVerified: false }),
    seedAccount(`mod_${suffix}`),
    seedAccount(`banned_${suffix}`),
  ]);
  const open = await seedActor(local, 'Group', `open_${suffix}`, {
    summaryMd: 'Local news that matters to the fediverse.',
    postingWarning: 'Read the rules before you post.',
  });
  await writer()
    .insert(communityRules)
    .values([
      { communityId: open.id, position: 1, title: 'Be civil', bodyMd: 'No harassment, slurs or *dogpiling*.' },
      { communityId: open.id, position: 2, title: 'Stay on topic', bodyMd: null },
    ]);
  const staff = await seedActor(local, 'Group', `staff_${suffix}`, { postingRestrictedToMods: true });
  await seedModerator(staff, { id: moderator.actorId });
  const closed = await seedActor(local, 'Group', `closed_${suffix}`);
  await seedBan(closed, { id: banned.actorId });
  const remote = await seedActor(lemmy, 'Group', `tech_${suffix}`);
  for (const person of [poster, unverified, moderator, banned]) {
    await writer().insert(follows).values({ followerId: person.actorId, followeeId: remote.id, state: 'accepted', acceptedAt: new Date() });
  }
  return {
    password: PASSWORD,
    people: { poster: poster.name, unverified: unverified.name, moderator: moderator.name, banned: banned.name },
    communities: {
      open: { id: open.id, handle: open.name },
      staff: { id: staff.id, handle: staff.name },
      closed: { id: closed.id, handle: closed.name },
      remote: { id: remote.id, handle: `${remote.name}@${lemmy.domain}` },
    },
  };
}

/** The uploads switch is lane ADM's to write in the product; a test flips the row directly, with the bucket ready. */
async function uploads(on: boolean) {
  if (on) await s3Store().ensureBucket();
  await writer()
    .insert(siteSettings)
    .values({ key: 'uploads.enabled', value: on })
    .onConflictDoUpdate({ target: siteSettings.key, set: { value: on } });
  return { uploads: on };
}

if (import.meta.main) {
  try {
    const [command, argument] = process.argv.slice(2);
    if (command === undefined) console.log(JSON.stringify(await world()));
    else if (command === 'uploads' && (argument === 'on' || argument === 'off'))
      console.log(JSON.stringify(await uploads(argument === 'on')));
    else throw new Error('usage: node e2e/composer/seed.ts [uploads on|off]');
  } finally {
    await closePools();
  }
}
