import { eq } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { communityBlocks, instanceBlocks } from '../blocks/tables.ts';
import { actors } from '../db/tables/actors.ts';
import { writer } from '../db/write.ts';
import { ageDeclarations } from '../identity/tables.ts';
import { peerControls } from '../peers/tables.ts';
import { truncateAll } from '../testing/db.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { seedModerator } from '../testing/seed-az.ts';
import { seedFeedWorld, seedFollow } from '../testing/seed-c1.ts';
import { sidebarCommunities } from './shell.ts';

beforeEach(truncateAll);

test('a signed-in viewer gets what they follow, split into local and remote, and how many they moderate', async () => {
  const { people, communities } = await seedFeedWorld();
  await seedFollow(people.viewer, communities.gone);
  await seedFollow(people.viewer, communities.deleted);
  const { local, remote, moderating } = await sidebarCommunities(people.viewer.id);
  // The pending follow stays listed; a removed or deleted community does not.
  expect(local.map(({ handle }) => handle)).toEqual(['news']);
  expect(remote.map(({ handle }) => handle)).toEqual(['pending@lemmy.test', 'technology@lemmy.test']);
  expect(moderating).toBe(1);
});

test('moderating counts a moderator row that holds a role now, not an expired or unconfirmed one', async () => {
  const { people, communities } = await seedFeedWorld();
  await seedModerator(communities.art, people.viewer, { expiresAt: new Date(Date.now() - 1000) });
  await seedModerator(communities.remoteTech, people.viewer, {
    source: 'remote',
    verifiedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
  });
  expect((await sidebarCommunities(people.viewer.id)).moderating).toBe(1);
  expect((await sidebarCommunities(people.stranger.id)).moderating).toBe(0);
});

test('moderating counts a sensitive community only once the moderator declared 16+, as the joined list lists it', async () => {
  const { people, communities } = await seedFeedWorld();
  await seedModerator(communities.adult, people.stranger);
  expect((await sidebarCommunities(people.stranger.id)).moderating).toBe(0);
  await writer().insert(ageDeclarations).values({ actorId: people.stranger.id });
  expect((await sidebarCommunities(people.stranger.id)).moderating).toBe(1);
});

test('a signed-out viewer, and a signed-in one with no follows, get the right lists', async () => {
  const { people } = await seedFeedWorld();
  // The sensitive local community is not listed to someone who has not declared.
  const anonymous = await sidebarCommunities(null);
  expect(anonymous.local.map(({ handle }) => handle)).toEqual(['art', 'news']);
  expect([anonymous.remote, anonymous.moderating]).toEqual([[], 0]);
  expect(await sidebarCommunities(people.stranger.id)).toEqual({ local: [], remote: [], moderating: 0 });
});

test("the joined list keeps to the viewer's age gate and host blocks, and keeps a follow that opted out of search", async () => {
  const { people, communities, instances } = await seedFeedWorld();
  // Not declared 16+, unlike the world's viewer.
  const me = people.stranger;
  const quiet = await seedInstance('quiet.test', false);
  const shut = await seedInstance('shut.test', false);
  const onQuiet = await seedActor(quiet, 'Group', 'hushed');
  const onShut = await seedActor(shut, 'Group', 'walled');
  // Opted out of search: still listed for the person who follows it, who found it already.
  const unlisted = await seedActor(instances.lemmy, 'Group', 'unlisted');
  await writer().update(actors).set({ discoverable: false }).where(eq(actors.id, unlisted.id));
  for (const community of [communities.news, communities.adult, onQuiet, onShut, unlisted]) await seedFollow(me, community);
  // The person blocks quiet.test; this server blocks shut.test.
  await writer().insert(instanceBlocks).values({ blockerId: me.id, instanceId: quiet.id });
  await writer().insert(peerControls).values({ instanceId: shut.id, blocked: true });
  const handles = async () => {
    const { local, remote } = await sidebarCommunities(me.id);
    return [...local, ...remote].map(({ handle }) => handle);
  };
  expect(await handles()).toEqual(['news', 'unlisted@lemmy.test']);
  // Once declared 16+, the sensitive community they follow is listed too.
  await writer().insert(ageDeclarations).values({ actorId: me.id });
  expect(await handles()).toEqual(['adult', 'news', 'unlisted@lemmy.test']);
  // A community they block themselves, followed again since, is not listed either.
  await writer().insert(communityBlocks).values({ blockerId: me.id, communityId: communities.news.id });
  expect(await handles()).toEqual(['adult', 'unlisted@lemmy.test']);
});
