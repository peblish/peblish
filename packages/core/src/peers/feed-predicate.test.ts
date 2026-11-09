import { beforeEach, expect, test } from 'vitest';
import { readFeed } from '../feeds/read.ts';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { seedPost } from '../testing/seed-az.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { peerControls } from './tables.ts';

beforeEach(truncateAll);

test('a blocked peer’s posts, and posts in its communities, leave every feed; the post itself stays in the database', async () => {
  const local = await seedInstance('feddit.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const piefed = await seedInstance('piefed.test', false);
  const here = await seedActor(local, 'Group', 'here');
  const lemmyGroup = await seedActor(lemmy, 'Group', 'lab');
  const piefedGroup = await seedActor(piefed, 'Group', 'pflab');
  const mine = await seedActor(local, 'Person', 'mine');
  const lemmyUser = await seedActor(lemmy, 'Person', 'lemmyuser');
  const piefedUser = await seedActor(piefed, 'Person', 'pfuser');
  const ours = await seedPost(local, here, mine);
  const byBlockedPerson = await seedPost(lemmy, here, lemmyUser);
  const inBlockedCommunity = await seedPost(local, lemmyGroup, mine);
  const fine = await seedPost(piefed, piefedGroup, piefedUser);
  const titles = async () => (await readFeed({ feed: 'all', sort: 'new' }, null)).items.map((post) => post.id).toSorted();
  expect(await titles()).toEqual([ours.id, byBlockedPerson.id, inBlockedCommunity.id, fine.id].toSorted());
  await writer().insert(peerControls).values({ instanceId: lemmy.id, blocked: true });
  expect(await titles()).toEqual([ours.id, fine.id].toSorted());
  await writer().insert(peerControls).values({ instanceId: piefed.id, inboxPaused: true, media: 'denied' });
  expect(await titles()).toEqual([ours.id, fine.id].toSorted());
});
