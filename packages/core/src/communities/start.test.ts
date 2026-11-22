import { beforeEach, expect, test } from 'vitest';
import { instanceBlocks } from '../blocks/tables.ts';
import { writer } from '../db/write.ts';
import { ageDeclarations } from '../identity/tables.ts';
import { peerControls } from '../peers/tables.ts';
import { truncateAll } from '../testing/db.ts';
import { seedBan, seedModerator } from '../testing/seed-az.ts';
import { seedBlock } from '../testing/seed-e1.ts';
import { seedPerson } from '../testing/seed-f.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { mayStartPostIn } from './start.ts';

// Where the composer may start a post, through post.create's own policy and the directory's
// block rules, with nothing stubbed.

beforeEach(truncateAll);

async function world() {
  const local = await seedInstance('feddit.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const shut = await seedInstance('shut.test', false);
  const declared = await seedPerson(local, 'mira');
  await writer().insert(ageDeclarations).values({ actorId: declared.id });
  const communities = {
    open: await seedActor(local, 'Group', 'news'),
    adult: await seedActor(local, 'Group', 'adult', { sensitive: true }),
    notices: await seedActor(local, 'Group', 'notices', { postingRestrictedToMods: true }),
    lab: await seedActor(lemmy, 'Group', 'lab'),
    walled: await seedActor(shut, 'Group', 'walled'),
  };
  await writer().insert(peerControls).values({ instanceId: shut.id, blocked: true });
  return { local, lemmy, declared, communities };
}

const may = (who: { id: string }, community: { id: string }, siteRole: 'user' | 'admin' = 'user') =>
  mayStartPostIn({ actorId: who.id, siteRole }, community.id);

test('a refusal about the person does not hide one about the community: an unverified or undeclared member starts in no gated community, nor one they are banned from', async () => {
  const { local, communities } = await world();
  const unverified = await seedPerson(local, 'otto', { emailVerified: false });
  const undeclared = await seedPerson(local, 'ben');
  expect(await may(unverified, communities.adult)).toBe(false);
  expect(await may(undeclared, communities.adult)).toBe(false);
  await seedBan(communities.open, unverified);
  expect(await may(unverified, communities.open)).toBe(false);
  // Nor anywhere else: they may post nowhere until the refusal about them is lifted.
  expect(await may(unverified, communities.lab)).toBe(false);
});

test('not in a community the member blocks, nor one on a host they or this server block', async () => {
  const { lemmy, declared, communities } = await world();
  await seedBlock(declared, communities.open);
  expect(await may(declared, communities.open)).toBe(false);
  expect(await may(declared, communities.walled)).toBe(false);
  await writer().insert(instanceBlocks).values({ blockerId: declared.id, instanceId: lemmy.id });
  expect(await may(declared, communities.lab)).toBe(false);
});

test('a declared, verified member starts where they may post, a mods-only community only as its staff; a banned one nowhere it bans them', async () => {
  const { local, declared, communities } = await world();
  expect(await Promise.all([communities.open, communities.adult, communities.lab].map((c) => may(declared, c)))).toEqual([
    true,
    true,
    true,
  ]);
  expect(await may(declared, communities.notices)).toBe(false);
  await seedModerator({ id: communities.notices.id }, declared);
  expect(await may(declared, communities.notices)).toBe(true);
  const banned = await seedPerson(local, 'nell');
  await seedBan(communities.open, banned);
  expect([await may(banned, communities.open), await may(banned, communities.lab)]).toEqual([false, true]);
});
