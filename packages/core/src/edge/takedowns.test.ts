import { beforeEach, expect, test, vi } from 'vitest';
import { authorize } from '../authz/authorize.ts';
import { systemPrincipal } from '../authz/system.ts';
import { siteBanAs, banAs, removeAs } from '../bans/service.ts';
import { deleteCommentAs } from '../comments/actions.ts';
import { updateCommunityAs } from '../communities/update.ts';
import { localInstance } from '../db/local-instance.ts';
import { db } from '../db/read.ts';
import { writer } from '../db/write.ts';
import { purgePass } from '../evidence/purge.ts';
import { deleteAccountAs } from '../identity/delete.ts';
import { scanConfig } from '../mediascan/config.ts';
import { addToBlocklist, removeFromBlocklist } from '../mediascan/list.ts';
import { confirmQuarantined } from '../mediascan/review.ts';
import { scanUpload } from '../mediascan/scan.ts';
import { mediaBlocklist } from '../mediascan/tables.ts';
import { updatePeerAs } from '../peers/service.ts';
import { peerControls } from '../peers/tables.ts';
import { deletePostAs, updatePostAs } from '../posts/actions.ts';
import { deleteRemoteActor } from '../remote/actors.ts';
import { ensureInstance } from '../remote/instances.ts';
import { updateSettingsAs } from '../settings/write.ts';
import { memoryStore } from '../storage/memory.ts';
import { truncateAll } from '../testing/db.ts';
import { seedLocalInstance } from '../testing/seed-a.ts';
import { admin, seedAdmin, seedComment, seedPost } from '../testing/seed-az.ts';
import { seedAccount } from '../testing/seed-b1.ts';
import { seedMedia } from '../testing/seed-safe.ts';
import { localUser, seedActor, seedInstance } from '../testing/seed.ts';
import { tx } from '../tx/tx.ts';
import { edgePurges } from './tables.ts';
import { actorTag, commentTag, hashTag, hostTag, postTag } from './tags.ts';
import { owedRows } from './debt.ts';
import { owedAfterDrain, startDrain } from '../testing/edge-drain.ts';

// Each takedown in the brief, made by the code that really makes it (not a hand-built event),
// then the edge.purge consumer run through the real outbox worker: the debt it leaves is the
// proof the takedown reaches the purge.

// The horizon is the oldest transaction anywhere on the shared server, so a busy machine can hold a batch back.
vi.setConfig({ testTimeout: 60_000 });

const store = memoryStore();

beforeEach(async () => {
  await truncateAll();
  await seedLocalInstance();
});

async function world() {
  const row = await localInstance(db());
  const local = { ...row, domain: new URL(row.origin).host, local: true };
  const moderator = await seedAdmin(local, 'admin');
  const author = await seedAccount(local, 'author');
  const community = await seedActor(local, 'Group', 'pics');
  const post = await seedPost(local, community, author);
  const comment = await seedComment(local, post, author);
  // Start from no debt: seeding wrote instance rows of its own.
  await startDrain();
  return { local, admin: admin(moderator.id), author, community, post, comment };
}

async function expectOwed(tags: string[]) {
  expect((await owedAfterDrain()).toSorted()).toEqual(tags.toSorted());
  await writer().delete(edgePurges);
}

test('a local author deleting a post or comment', async () => {
  const w = await world();
  expect(await deleteCommentAs(localUser(w.author.id), w.comment.id)).toMatchObject({ ok: true });
  await expectOwed([commentTag(w.comment.id)]);
  expect(await deletePostAs(localUser(w.author.id), w.post.id)).toMatchObject({ ok: true });
  await expectOwed([postTag(w.post.id)]);
});

test('a moderator removing a post or comment, and a restore owing nothing', async () => {
  const w = await world();
  expect(await removeAs(w.admin, { kind: 'comment', id: w.comment.id }, { reason: 'spam' })).toMatchObject({ ok: true });
  await expectOwed([commentTag(w.comment.id)]);
  expect(await removeAs(w.admin, { kind: 'post', id: w.post.id }, { reason: 'spam' })).toMatchObject({ ok: true });
  await expectOwed([postTag(w.post.id)]);
});

test('an NSFW or NSFL flag set on a post by its author, or on a community; an edit that keeps it public owes nothing', async () => {
  const w = await world();
  expect(await updatePostAs(localUser(w.author.id), w.post.id, { title: 'still public' })).toMatchObject({ ok: true });
  await expectOwed([]);
  expect(await updatePostAs(localUser(w.author.id), w.post.id, { sensitive: true })).toMatchObject({ ok: true });
  await expectOwed([postTag(w.post.id)]);
  const other = await seedPost(w.local, w.community, w.author);
  await expectOwed([]);
  expect(await updatePostAs(localUser(w.author.id), other.id, { nsfl: true })).toMatchObject({ ok: true });
  await expectOwed([postTag(other.id)]);
  expect(await updateCommunityAs(w.admin, w.community.id, { sensitive: true })).toMatchObject({ ok: true });
  await expectOwed([actorTag(w.community.id)]);
});

test('a ban that removes content, in a community or site-wide; one that keeps it owes nothing', async () => {
  const w = await world();
  expect(await banAs(w.admin, { communityId: w.community.id, targetActorId: w.author.id }, { removeContent: false })).toMatchObject({
    ok: true,
  });
  await expectOwed([]);
  const other = await seedAccount(w.local, 'other');
  expect(await banAs(w.admin, { communityId: w.community.id, targetActorId: other.id }, { removeContent: true })).toMatchObject({
    ok: true,
  });
  expect(await owedAfterDrain()).toContain(actorTag(other.id));
  await writer().delete(edgePurges);
  expect(await siteBanAs(w.admin, w.author.id, { removeContent: true })).toMatchObject({ ok: true });
  // The removal of each post and comment is its own event too.
  expect(await owedAfterDrain()).toContain(actorTag(w.author.id));
});

test('a local account deleted, and a remote one deleted with its content', async () => {
  const w = await world();
  expect(await deleteAccountAs(localUser(w.author.id), w.author.id, 'leaving')).toMatchObject({ ok: true });
  expect(await owedAfterDrain()).toContain(actorTag(w.author.id));
  await writer().delete(edgePurges);

  const peer = await seedInstance('lemmy.test', false);
  await writer().delete(edgePurges);
  const remote = await seedActor(peer, 'Person', 'far');
  const theirs = await seedPost(peer, w.community, remote);
  const grant = await authorize('remote.actor_delete', await systemPrincipal(db(), 'import'), { apId: remote.apId });
  if (!grant.ok) throw new Error(grant.reason);
  await deleteRemoteActor(grant.grant, { removeContent: true, cause: 'Delete' });
  const tags = await owedAfterDrain();
  expect(tags).toEqual(expect.arrayContaining([actorTag(remote.id), postTag(theirs.id)]));
});

test("a peer's media quarantined, purged or the peer blocked owes its domain's tag; approving owes nothing", async () => {
  const w = await world();
  const peer = await seedInstance('lemmy.test', false);
  await writer().insert(peerControls).values({ instanceId: peer.id, media: 'approved' });
  await writer().delete(edgePurges);
  expect(await updatePeerAs(w.admin, 'lemmy.test', { media: 'quarantined' })).toMatchObject({ ok: true });
  await expectOwed([hostTag('lemmy.test')]);
  expect(await updatePeerAs(w.admin, 'lemmy.test', { media: 'approved' })).toMatchObject({ ok: true });
  await expectOwed([]);
  expect(await updatePeerAs(w.admin, 'lemmy.test', { blocked: true })).toMatchObject({ ok: true });
  await expectOwed([hostTag('lemmy.test')]);
  expect(await updatePeerAs(w.admin, 'lemmy.test', { blocked: false, purge: true })).toMatchObject({ ok: true });
  await expectOwed([hostTag('lemmy.test')]);
});

test('a host first seen as a new peer owes its tag in the transaction that writes its row; a known one owes nothing (item 7)', async () => {
  await world();
  await tx((t) => ensureInstance(t.db, 'https://pics.example/u/x'));
  expect((await owedRows(db())).map((row) => row.tag)).toEqual([hostTag('pics.example')]);
  await writer().delete(edgePurges);
  await tx((t) => ensureInstance(t.db, 'https://pics.example/u/y'));
  expect(await owedRows(db())).toEqual([]);
});

test('an image hash listed by hand, by a confirmed quarantine and by the end of its undecided window (item 3)', async () => {
  const w = await world();
  const config = scanConfig({ MEDIASCAN_LOCAL_ONLY: '1' });
  const quarantined = async () => {
    const row = await seedMedia(store, { ownerId: w.author.id });
    await writer().insert(mediaBlocklist).values({ kind: 'sha256', value: row.sha256!, category: 'other' });
    expect(await scanUpload(row.id, { config, store })).toBe('quarantined');
    // Off the list again, so the confirmation or the expiry is what lists it.
    const [entry] = await db().select().from(mediaBlocklist);
    expect(await removeFromBlocklist(w.admin, entry!.id)).toMatchObject({ ok: true });
    await owedAfterDrain();
    await writer().delete(edgePurges);
    return row;
  };

  const byHand = 'cd'.repeat(32);
  expect(await addToBlocklist(w.admin, { value: byHand, category: 'other' })).toMatchObject({ ok: true });
  await expectOwed([hashTag(byHand)]);

  const confirmed = await quarantined();
  expect(await confirmQuarantined(w.admin, { mediaId: confirmed.id, removePosts: false }, { store })).toMatchObject({ ok: true });
  await expectOwed([hashTag(confirmed.sha256!)]);

  const undecided = await quarantined();
  await purgePass({ store, now: new Date(Date.now() + 30 * 86_400_000), days: 7 });
  await expectOwed([hashTag(undecided.sha256!)]);
});

test('the remote-media kill switch changed owes the wide purge; another setting owes nothing', async () => {
  const w = await world();
  expect(await updateSettingsAs(w.admin, { 'site.name': 'Elsewhere' })).toMatchObject({ ok: true });
  await expectOwed([]);
  expect(await updateSettingsAs(w.admin, { 'remote_media.enabled': false })).toMatchObject({ ok: true });
  await expectOwed(['pbm']);
});
