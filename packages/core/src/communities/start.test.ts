import { beforeEach, expect, test } from 'vitest';
import { instanceBlocks } from '../blocks/tables.ts';
import { writer } from '../db/write.ts';
import { ageDeclarations } from '../identity/tables.ts';
import { peerControls } from '../peers/tables.ts';
import { truncateAll } from '../testing/db.ts';
import { seedBan, seedCommunityRemoval } from '../testing/seed-az.ts';
import { seedBlock } from '../testing/seed-e1.ts';
import { seedPerson } from '../testing/seed-f.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { composerCommunity } from './start.ts';

// Which community the composer may start in and show (its picker row and its panel), with
// nothing stubbed: every community a member could see starts the form, whether or not they may
// post there; one they could not see is not there at all.

beforeEach(truncateAll);

async function world() {
  const local = await seedInstance('feddit.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const shut = await seedInstance('shut.test', false);
  const member = await seedPerson(local, 'mira');
  await writer().insert(ageDeclarations).values({ actorId: member.id });
  const communities = {
    open: await seedActor(local, 'Group', 'news'),
    adult: await seedActor(local, 'Group', 'adult', { sensitive: true }),
    notices: await seedActor(local, 'Group', 'notices', { postingRestrictedToMods: true }),
    lab: await seedActor(lemmy, 'Group', 'lab'),
    walled: await seedActor(shut, 'Group', 'walled'),
    closed: await seedActor(local, 'Group', 'closed'),
  };
  await writer().insert(peerControls).values({ instanceId: shut.id, blocked: true });
  await seedCommunityRemoval(communities.closed);
  return { local, lemmy, member, communities };
}

/** What the composer gets for `key`: the community's id and its mods-only flag, or null for nothing. */
const shown = async (who: { id: string }, key: string, declared = true) => {
  const community = await composerCommunity({ actorId: who.id, declared }, key);
  return community && { id: community.actor.id, restricted: community.postingRestrictedToMods };
};

test('a community the member can see starts the form, whether or not they may post there', async () => {
  const { local, member, communities } = await world();
  const open = { id: communities.open.id, restricted: false };
  // May post: by id, by name, with the `!`, and a remote one by name@host.
  expect(await shown(member, communities.open.id)).toEqual(open);
  expect(await shown(member, 'News')).toEqual(open);
  expect(await shown(member, '!news')).toEqual(open);
  expect(await shown(member, 'lab@lemmy.test')).toEqual({ id: communities.lab.id, restricted: false });
  // Mods-only: it starts, and says so.
  expect(await shown(member, 'notices')).toEqual({ id: communities.notices.id, restricted: true });
  // Banned from it.
  await seedBan(communities.open, member);
  expect(await shown(member, 'news')).toEqual(open);
  // An email not yet verified.
  const unverified = await seedPerson(local, 'otto', { emailVerified: false });
  expect(await shown(unverified, 'news', false)).toEqual(open);
  // A sensitive community, once the member declared 16+.
  expect(await shown(member, 'adult')).toEqual({ id: communities.adult.id, restricted: false });
});

test('one the member cannot see sends nothing: age-gated without a declaration, blocked, on a blocked host, removed or not there', async () => {
  const { lemmy, member, communities } = await world();
  expect(await shown(member, 'adult', false)).toBeNull();
  await seedBlock(member, communities.open);
  expect(await shown(member, communities.open.id)).toBeNull();
  // This server blocks shut.test; the member blocks lemmy.test.
  expect(await shown(member, 'walled@shut.test')).toBeNull();
  await writer().insert(instanceBlocks).values({ blockerId: member.id, instanceId: lemmy.id });
  expect(await shown(member, 'lab@lemmy.test')).toBeNull();
  expect(await shown(member, 'closed')).toBeNull();
  expect(await shown(member, 'nowhere')).toBeNull();
  expect(await shown(member, '0192f5a0-1234-7abc-8def-0123456789ab')).toBeNull();
  expect(await shown(member, ' ')).toBeNull();
});
