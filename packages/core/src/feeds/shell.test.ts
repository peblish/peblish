import { beforeEach, expect, test } from 'vitest';
import { truncateAll } from '../testing/db.ts';
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

test('a signed-out viewer, and a signed-in one with no follows, get the right lists', async () => {
  const { people } = await seedFeedWorld();
  // The sensitive local community is not listed to someone who has not declared.
  const anonymous = await sidebarCommunities(null);
  expect(anonymous.local.map(({ handle }) => handle)).toEqual(['art', 'news']);
  expect([anonymous.remote, anonymous.moderating]).toEqual([[], 0]);
  expect(await sidebarCommunities(people.stranger.id)).toEqual({ local: [], remote: [], moderating: 0 });
});
