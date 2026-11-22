import { beforeEach, expect, test } from 'vitest';
import { communityBlocks, instanceBlocks } from '../blocks/tables.ts';
import { writer } from '../db/write.ts';
import { ageDeclarations } from '../identity/tables.ts';
import { peerControls } from '../peers/tables.ts';
import { truncateAll } from '../testing/db.ts';
import { seedCommunityRemoval, seedModerator } from '../testing/seed-az.ts';
import { seedActor, seedInstance } from '../testing/seed.ts';
import { moderatesMax, readModerates } from './moderates.ts';

beforeEach(truncateAll);

const hour = 3_600_000;

async function world() {
  const local = await seedInstance('feddit.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const shady = await seedInstance('shady.test', false);
  const subject = await seedActor(local, 'Person', 'subject');
  const viewer = await seedActor(local, 'Person', 'viewer');
  const group = (instance: typeof local, name: string, extra: Parameters<typeof seedActor>[3] = {}) =>
    seedActor(instance, 'Group', name, extra);
  const c = {
    bikes: await group(local, 'bikes'),
    remote: await group(lemmy, 'technology'),
    nsfw: await group(local, 'after_dark', { sensitive: true }),
    removed: await group(local, 'removed'),
    deleted: await group(local, 'gone', { deletedAt: new Date() }),
    hidden: await group(local, 'hidden', { discoverable: false }),
    onBlockedPeer: await group(shady, 'shady'),
    blockedByViewer: await group(local, 'blocked'),
    onViewerBlockedInstance: await group(lemmy, 'cooking'),
    expired: await group(local, 'expired'),
    unverified: await group(lemmy, 'unverified'),
    staleRemote: await group(lemmy, 'stale'),
  };
  await seedModerator(c.bikes, subject);
  await seedModerator(c.remote, subject, { source: 'remote', expiresAt: new Date(Date.now() + hour) });
  for (const community of [c.nsfw, c.removed, c.deleted, c.hidden, c.onBlockedPeer, c.blockedByViewer])
    await seedModerator(community, subject);
  await seedModerator(c.onViewerBlockedInstance, subject, { source: 'remote', expiresAt: new Date(Date.now() + hour) });
  await seedModerator(c.expired, subject, { expiresAt: new Date(Date.now() - hour) });
  await seedModerator(c.unverified, subject, { source: 'remote', verifiedAt: null, expiresAt: new Date(Date.now() + hour) });
  await seedModerator(c.staleRemote, subject, { source: 'remote', expiresAt: new Date(Date.now() - hour) });
  await seedCommunityRemoval(c.removed);
  await writer().insert(peerControls).values({ instanceId: shady.id, blocked: true });
  return { local, lemmy, subject, viewer, c };
}

const handles = (moderates: Awaited<ReturnType<typeof readModerates>>) => moderates.communities.map((community) => community.handle);

test('Moderates lists only roles that grant here, in communities the viewer may see', async () => {
  const w = await world();
  // Signed out: no flagged community, no viewer blocks to apply.
  expect(handles(await readModerates(w.subject.id, null))).toEqual(['bikes', 'blocked', 'cooking@lemmy.test', 'technology@lemmy.test']);
  await writer().insert(communityBlocks).values({ blockerId: w.viewer.id, communityId: w.c.blockedByViewer.id });
  await writer().insert(instanceBlocks).values({ blockerId: w.viewer.id, instanceId: w.lemmy.id });
  const signedIn = { actorId: w.viewer.id, siteRole: 'user' as const };
  expect(handles(await readModerates(w.subject.id, signedIn))).toEqual(['bikes']);
  // A 16+ declaration opens the flagged community, as the feeds' gate does.
  await writer().insert(ageDeclarations).values({ actorId: w.viewer.id });
  expect(handles(await readModerates(w.subject.id, signedIn))).toEqual(['after_dark', 'bikes']);
});

test('the list is bounded, and says when there are more', async () => {
  const local = await seedInstance('feddit.test');
  const subject = await seedActor(local, 'Person', 'busy');
  for (let i = 0; i <= moderatesMax; i++) await seedModerator(await seedActor(local, 'Group', `c${String(i).padStart(2, '0')}`), subject);
  const moderates = await readModerates(subject.id, null);
  expect(moderates.communities).toHaveLength(moderatesMax);
  expect(moderates.more).toBe(true);
  expect(Object.keys(moderates.communities[0] ?? {}).sort()).toEqual(['apId', 'displayName', 'handle', 'id', 'kind', 'local', 'name']);
});
