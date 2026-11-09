import { eq } from 'drizzle-orm';
import { instances } from '../db/tables/instances.ts';
import { uuidv7 } from 'uuidv7';
import { actorKeys, actors } from '../db/tables/actors.ts';
import { inboxRaw } from '../db/tables/federation.ts';
import { follows } from '../db/tables/follows.ts';
import { writer } from '../db/write.ts';
import { seedModerator, seedPost } from './seed-az.ts';
import { rsaKeys, seedLocalInstance, seedSigningKey } from './seed-fed-a.ts';
import { seedAccount } from './seed-b1.ts';
import { seedLabLive } from './seed-fit.ts';
import { seedActor, seedInstance } from './seed.ts';

// Lane FED-B's seeds: the world the inbound pipeline's tests run in. A local community with
// an owner and a follower, a Lemmy-like peer with a user, a moderator and a community this
// server follows, and a rogue peer. Test code only.

type Instance = Awaited<ReturnType<typeof seedInstance>>;

/** A peer's Person (`/u/<name>`) or Group (`/c/<name>`), at the ap_id Lemmy would give it, with a key we can sign as. */
export async function seedPeerActor(instance: Instance, kind: 'Person' | 'Group', name: string) {
  const apId = `https://${instance.domain}/${kind === 'Group' ? 'c' : 'u'}/${name}`;
  const keys = rsaKeys();
  const actor = await seedActor(instance, kind, name, {
    apId,
    inboxUrl: `${apId}/inbox`,
    sharedInboxUrl: `https://${instance.domain}/inbox`,
    outboxUrl: `${apId}/outbox`,
    followersUrl: `${apId}/followers`,
    moderatorsUrl: kind === 'Group' ? `${apId}/moderators` : null,
    featuredUrl: kind === 'Group' ? `${apId}/featured` : null,
    fetchedAt: new Date(),
  });
  await writer()
    .insert(actorKeys)
    .values({ actorId: actor.id, keyId: `${apId}#main-key`, algorithm: 'rsa', publicKeyPem: keys.publicKeyPem });
  return { ...actor, keys: { keyId: `${apId}#main-key`, ...keys } };
}

/** A follow of `community` by `follower`, accepted unless `state` says otherwise. */
export async function seedFollow(
  follower: { id: string },
  community: { id: string },
  apId: string,
  state: 'pending' | 'accepted' = 'accepted',
) {
  await writer()
    .insert(follows)
    .values({ followerId: follower.id, followeeId: community.id, apId, state, acceptedAt: state === 'accepted' ? new Date() : null });
}

/**
 * The world of the inbound tests, all on `*.test` hosts (nothing is contacted):
 * - this server, `fed-b.test`, with its community `spike` (owner `owner`, a local follower
 *   `alice` with an account, and a signing key for the Announces it sends);
 * - `lemmy.test`: `lemmyuser`, `lemmyadmin` (a moderator of `spike`, appointed here), its
 *   community `lab`, which `alice` follows (accepted), and `piefed.test` with `pfuser`;
 * - `rogue.test`: `mallory` and the Group `fake`, which `alice` follows, as the spike's rogue peer was;
 * - `t1`, a post by `lemmyuser` in `spike`; `t2`, a post by `lemmyuser` in `lab`.
 * A follower `remoteFollower` on `mastodon.test` follows `spike`, for the relay.
 */
export async function seedInboundWorld() {
  const { instance: local, instanceActor } = await seedLocalInstance('fed-b.test');
  const lemmy = await seedInstance('lemmy.test', false);
  const piefed = await seedInstance('piefed.test', false);
  const rogue = await seedInstance('rogue.test', false);
  const mastodon = await seedInstance('mastodon.test', false);
  const community = await seedActor(local, 'Group', 'spike', {
    inboxUrl: 'https://fed-b.test/ap/c.spike/inbox',
    sharedInboxUrl: 'https://fed-b.test/inbox',
    outboxUrl: 'https://fed-b.test/ap/c.spike/outbox',
    followersUrl: 'https://fed-b.test/ap/c.spike/followers',
  });
  const communityKey = await seedSigningKey(community);
  const owner = await seedAccount(local, 'owner');
  await seedModerator(community, owner, { role: 'owner' });
  const alice = await seedAccount(local, 'alice');
  const peers = {
    lemmyuser: await seedPeerActor(lemmy, 'Person', 'lemmyuser'),
    lemmyadmin: await seedPeerActor(lemmy, 'Person', 'lemmyadmin'),
    lab: await seedPeerActor(lemmy, 'Group', 'lab'),
    pfuser: await seedPeerActor(piefed, 'Person', 'pfuser'),
    mallory: await seedPeerActor(rogue, 'Person', 'mallory'),
    fake: await seedPeerActor(rogue, 'Group', 'fake'),
    remoteFollower: await seedPeerActor(mastodon, 'Person', 'follower'),
  };
  await seedModerator(community, peers.lemmyadmin);
  await seedFollow(alice, peers.lab, 'https://fed-b.test/ap/activity/follow-lab');
  await seedFollow(alice, peers.fake, 'https://fed-b.test/ap/activity/follow-fake');
  await seedFollow(peers.remoteFollower, community, 'https://mastodon.test/activities/follow-spike');
  const t1 = await seedPost(local, community, peers.lemmyuser, { apId: 'https://lemmy.test/post/1', local: false, instanceId: lemmy.id });
  const t2 = await seedPost(lemmy, peers.lab, peers.lemmyuser, { apId: 'https://lemmy.test/post/2' });
  return { instances: { local, lemmy, piefed, rogue, mastodon }, instanceActor, community, communityKey, owner, alice, peers, t1, t2 };
}

/** Stores a request body as a pending inbox_raw row, as receiveInbound does, and returns the row as the job leases it. */
export async function seedInboxRow(body: string | Uint8Array, extra: Partial<typeof inboxRaw.$inferInsert> = {}) {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const [row] = await writer()
    .insert(inboxRaw)
    .values({ id: uuidv7(), body: bytes, attempts: 1, ...extra })
    .returning();
  if (!row) throw new Error('inbox_raw insert returned nothing');
  return {
    id: row.id,
    activityId: row.activityId,
    activityType: row.activityType,
    actorApId: row.actorApId,
    body: bytes,
    headers: row.headers,
    attempts: 1,
    receivedAt: row.receivedAt,
  };
}

/** The state of an inbox row. */
export async function inboxState(id: string) {
  const [row] = await writer().select({ state: inboxRaw.state, error: inboxRaw.error }).from(inboxRaw).where(eq(inboxRaw.id, id));
  return row;
}

/**
 * Stores `json` as an inbox row and runs `process` on it (the pipeline, passed in because core
 * imports nothing from federation). Returns the row, what `process` said and what the row
 * records afterwards.
 */
export async function deliverRow<Settled>(
  json: Record<string, unknown>,
  process: (row: Awaited<ReturnType<typeof seedInboxRow>>) => Promise<Settled>,
) {
  const row = await seedInboxRow(JSON.stringify(json), {
    activityId: typeof json.id === 'string' ? json.id : null,
    activityType: typeof json.type === 'string' ? json.type : null,
    actorApId: typeof json.actor === 'string' ? json.actor : null,
  });
  const settled = await process(row);
  return { row, settled, stored: await inboxState(row.id) };
}

/**
 * The Phase 0 lab as the inbound pipeline's world: lab-live with the spike's instance
 * (feddit.lab.test) as this server, its instance actor, every peer actor freshly fetched
 * (nothing reaches the network), and the peers' people appointed moderators of the spike's
 * community by its owner, as the lab's moderation scenarios did.
 */
export async function seedLabWorld() {
  const lab = await seedLabLive({ local: true });
  const [local] = await writer().select().from(instances).where(eq(instances.local, true));
  await seedActor(local!, 'Application', local!.domain, { apId: `https://${local!.domain}/` });
  await writer().update(actors).set({ fetchedAt: new Date() }).where(eq(actors.local, false));
  const spike = { id: lab.id('https://feddit.lab.test/ap/c.spike') };
  for (const name of ['lemmy.lab.test/u/lemmyadmin', 'piefed.lab.test/u/pfadmin', 'piefed.lab.test/u/pfuser']) {
    await seedModerator(spike, { id: lab.id(`https://${name}`) });
  }
  return lab;
}
