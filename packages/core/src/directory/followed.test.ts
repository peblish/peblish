import { beforeEach, expect, test } from 'vitest';
import { communityBlocks, instanceBlocks } from '../blocks/tables.ts';
import { writer } from '../db/write.ts';
import { peerControls } from '../peers/tables.ts';
import { truncateAll } from '../testing/db';
import { seedFollow } from '../testing/seed-c1.ts';
import { seedDirectoryWorld } from '../testing/seed-disc';
import { followedListed } from './followed.ts';
import { defaultQuery, type DirectoryQuery } from './input.ts';

let world: Awaited<ReturnType<typeof seedDirectoryWorld>>;
beforeEach(async () => {
  await truncateAll();
  world = await seedDirectoryWorld();
});

const listed = async (query: Partial<DirectoryQuery>, viewer: { actorId: string; declared: boolean }) =>
  (await followedListed({ ...defaultQuery, ...query }, viewer)).map(({ actor, follow }) => `${actor.handle} ${follow}`);

test('the viewer’s own communities that the directory lists them, joined or asked, by name; never removed, deleted or flagged', async () => {
  const { viewer } = world.people;
  for (const community of [world.communities.gone, world.communities.deleted, world.communities.adult, world.communities.adultRemote])
    await seedFollow(viewer, community);
  const declared = { actorId: viewer.id, declared: true };
  expect(await listed({}, declared)).toEqual(['News pending', 'technology@lemmy.test accepted']);
  // The search narrows them as it narrows the directory.
  expect(await listed({ q: 'tech' }, declared)).toEqual(['technology@lemmy.test accepted']);
});

test('none the viewer blocked, directly or by its instance, none on a host this server blocks, none age-gated', async () => {
  const { minor } = world.people;
  const { news, art, quiet, technology, adult } = world.communities;
  for (const community of [news, art, quiet, technology, adult]) await seedFollow(minor, community);
  await writer().insert(communityBlocks).values({ blockerId: minor.id, communityId: art.id });
  await writer().insert(instanceBlocks).values({ blockerId: minor.id, instanceId: quiet.instanceId });
  await writer().insert(peerControls).values({ instanceId: technology.instanceId, blocked: true });
  expect(await listed({}, { actorId: minor.id, declared: false })).toEqual(['News accepted']);
});
