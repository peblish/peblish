import { communityRules } from '../../packages/core/src/communities/tables.ts';
import { closePools } from '../../packages/core/src/db/pools.ts';
import { db } from '../../packages/core/src/db/read.ts';
import { localInstance } from '../../packages/core/src/db/local-instance.ts';
import { follows } from '../../packages/core/src/db/tables/follows.ts';
import { siteSettings } from '../../packages/core/src/db/tables/site.ts';
import { writer } from '../../packages/core/src/db/write.ts';
import { s3Store } from '../../packages/core/src/storage/s3.ts';
import { PASSWORD, seedAccount } from '../../packages/core/src/testing/seed-a.ts';
import { seedBan, seedCommunityRemoval, seedModerator } from '../../packages/core/src/testing/seed-az.ts';
import { seedActor, seedInstance } from '../../packages/core/src/testing/seed.ts';

// What e2e/composer runs against, on the lane database (DATABASE_URL from scripts/lane.sh):
// `node e2e/composer/seed.ts` prints the cast as JSON. Every run uses fresh names, so the lane
// database can keep earlier runs. `node e2e/composer/seed.ts uploads on|off` flips the switch.

async function world() {
  const suffix = Math.random().toString(36).slice(2, 8);
  const host = new URL((await localInstance(db())).origin).host;
  const local = { ...(await localInstance(db())), domain: host, local: true };
  const lemmy = await seedInstance(`lemmy-${suffix}.test`, false);
  const [poster, unverified, moderator, banned, young] = await Promise.all([
    seedAccount(`poster_${suffix}`),
    seedAccount(`unverified_${suffix}`, { emailVerified: false }),
    seedAccount(`mod_${suffix}`),
    seedAccount(`banned_${suffix}`),
    seedAccount(`young_${suffix}`),
  ]);
  // Registration records the 16+ declaration; this account has none.
  await writer().execute(`delete from age_declarations where actor_id = '${young.actorId}'`);
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
  // Age-gated here, and the remote Groups a person can follow without being able to post in them.
  const adult = await seedActor(local, 'Group', `adult_${suffix}`, { sensitive: true });
  const gated = await seedActor(lemmy, 'Group', `lewd_${suffix}`, { nsfl: true });
  const gone = await seedActor(lemmy, 'Group', `gone_${suffix}`);
  await seedCommunityRemoval(gone);
  const remoteStaff = await seedActor(lemmy, 'Group', `modsonly_${suffix}`, { postingRestrictedToMods: true });
  // Names with no break in them, for the 320px layout: a local one with a long rule, a remote one on a long host.
  const long = await seedActor(local, 'Group', `averyveryverylongcommunitynamewithnospaces_${suffix}`);
  await writer()
    .insert(communityRules)
    .values([
      {
        communityId: long.id,
        position: 1,
        title: 'Postsabouttheweatherbelongintheweathercommunityplease',
        bodyMd: 'See https://weather.far-away.test/a/very/long/path/without/any/spaces/in/it/at/all for that.',
      },
    ]);
  const farHost = await seedInstance(`a-very-long-instance-host-name-${suffix}.far-away.test`, false);
  const farAway = await seedActor(farHost, 'Group', `anotherlongremotecommunityname_${suffix}`);
  for (const person of [poster, unverified, moderator, banned, young]) {
    for (const followee of [remote, gated, gone, remoteStaff, farAway]) {
      await writer()
        .insert(follows)
        .values({ followerId: person.actorId, followeeId: followee.id, state: 'accepted', acceptedAt: new Date() });
    }
  }
  return {
    password: PASSWORD,
    people: { poster: poster.name, unverified: unverified.name, moderator: moderator.name, banned: banned.name, young: young.name },
    communities: {
      open: { id: open.id, handle: open.name },
      staff: { id: staff.id, handle: staff.name },
      closed: { id: closed.id, handle: closed.name },
      remote: { id: remote.id, handle: `${remote.name}@${lemmy.domain}` },
      adult: { id: adult.id, handle: adult.name },
      gated: { id: gated.id, handle: `${gated.name}@${lemmy.domain}` },
      gone: { id: gone.id, handle: `${gone.name}@${lemmy.domain}` },
      remoteStaff: { id: remoteStaff.id, handle: `${remoteStaff.name}@${lemmy.domain}` },
      long: { id: long.id, handle: long.name },
      farAway: { id: farAway.id, handle: `${farAway.name}@${farHost.domain}` },
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
