import { sql } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import { writer } from '../db/write.ts';
import { truncateAll } from '../testing/db.ts';
import { admin, seedAdmin, seedComment, seedModerator, seedPost } from '../testing/seed-az.ts';
import { localUser, seedActor, seedInstance } from '../testing/seed.ts';
import { contentCounts, findActorByHandle, listSiteBans, moderatedCommunities } from './read.ts';
import { siteBanAs, siteUnbanAs } from './service.ts';

beforeEach(truncateAll);

async function world() {
  const local = await seedInstance('feddit.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const andrew = await seedAdmin(local, 'Andrew');
  const mira = await seedActor(local, 'Person', 'Mira');
  const spammer = await seedActor(local, 'Person', 'spammer');
  const remote = await seedActor(lemmy, 'Person', 'wasp');
  const technik = await seedActor(local, 'Group', 'technik');
  const art = await seedActor(local, 'Group', 'art');
  const remoteGroup = await seedActor(lemmy, 'Group', 'lab');
  await seedModerator(technik, mira);
  await seedModerator(remoteGroup, mira, { source: 'remote', verifiedAt: null });
  return { local, lemmy, andrew, mira, spammer, remote, technik, art, remoteGroup };
}

test('a handle finds a local actor by name, or a remote one by name@host, of the kind asked for', async () => {
  const w = await world();
  expect(await findActorByHandle('@MIRA', 'Person')).toMatchObject({ id: w.mira.id, handle: 'Mira', local: true });
  expect(await findActorByHandle('mira@feddit.test', 'Person')).toMatchObject({ id: w.mira.id });
  expect(await findActorByHandle('@wasp@lemmy.test', 'Person')).toMatchObject({ id: w.remote.id, handle: 'wasp@lemmy.test', local: false });
  expect(await findActorByHandle('!technik', 'Group')).toMatchObject({ id: w.technik.id });
  expect(await findActorByHandle('technik', 'Person')).toBeNull();
  expect(await findActorByHandle('wasp', 'Person')).toBeNull();
  expect(await findActorByHandle('wasp@elsewhere.test', 'Person')).toBeNull();
  expect(await findActorByHandle('a@b@c', 'Person')).toBeNull();
});

test('the communities someone moderates are the ones with a fresh moderator row', async () => {
  const w = await world();
  expect((await moderatedCommunities(w.mira.id)).map((community) => community.handle)).toEqual(['technik']);
  expect(await moderatedCommunities(w.spammer.id)).toEqual([]);
});

test('counts are the live posts and comments, in one community or everywhere', async () => {
  const w = await world();
  const live = await seedPost(w.local, w.technik, w.spammer);
  await seedPost(w.local, w.art, w.spammer);
  await seedPost(w.local, w.art, w.spammer, { removedAt: new Date() });
  await seedPost(w.local, w.art, w.spammer, { deletedAt: new Date() });
  await seedComment(w.local, live, w.spammer);
  await seedComment(w.local, live, w.spammer, { removedAt: new Date() });
  expect(await contentCounts(w.spammer.id)).toEqual({ posts: 2, comments: 1 });
  expect(await contentCounts(w.spammer.id, w.technik.id)).toEqual({ posts: 1, comments: 1 });
  expect(await contentCounts(w.spammer.id, w.art.id)).toEqual({ posts: 1, comments: 0 });
});

test('the list holds the bans in force, newest first, and the service answers a refusal as a result', async () => {
  const w = await world();
  const asAdmin = admin(w.andrew.id);
  expect(await siteBanAs(asAdmin, w.spammer.id, { reason: 'Spam' })).toMatchObject({ ok: true });
  expect(await siteBanAs(asAdmin, w.spammer.id, {})).toEqual({ ok: false, reason: 'target.site_banned' });
  expect(await siteBanAs(localUser(w.mira.id), w.remote.id, {})).toEqual({ ok: false, reason: 'auth.admin_required' });
  await siteBanAs(asAdmin, w.remote.id, { expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  const rows = await listSiteBans();
  expect(rows.map((row) => [row.person.handle, row.home, row.reason, row.source, row.bannedBy?.handle])).toEqual([
    ['wasp@lemmy.test', 'lemmy.test', null, 'local', 'Andrew'],
    ['spammer', 'feddit.test', 'Spam', 'local', 'Andrew'],
  ]);
  expect(rows[0]?.expiresAt).not.toBeNull();
  await writer().execute(sql`update site_bans set expires_at = now() - interval '1 second' where actor_id = ${w.remote.id}`);
  expect((await listSiteBans()).map((row) => row.person.handle)).toEqual(['spammer']);
  expect(await siteUnbanAs(asAdmin, w.spammer.id, {})).toMatchObject({ ok: true });
  expect(await listSiteBans()).toEqual([]);
});
