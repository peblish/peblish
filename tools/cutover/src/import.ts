import { authorize } from '@peblish/core/authz/authorize';
import { systemPrincipal } from '@peblish/core/authz/system';
import { markdown, replaceLanguages } from '@peblish/core/communities/fields';
import { canonicalOrigin } from '@peblish/core/config';
import { actorKeys, actors } from '@peblish/core/db/tables/actors';
import { authUser } from '@peblish/core/db/tables/auth';
import { follows } from '@peblish/core/db/tables/follows';
import { instances } from '@peblish/core/db/tables/instances';
import { siteSettings } from '@peblish/core/db/tables/site';
import { communityModerators } from '@peblish/core/db/tables/moderation';
import { peerControls } from '@peblish/core/peers/tables';
import { updatePeer } from '@peblish/core/peers/update';
import { updateSettings } from '@peblish/core/settings/write';
import type { WriteTx } from '@peblish/core/db/write';
import { storeRemoteActor } from '@peblish/core/remote/actors';
import { tx, type Tx } from '@peblish/core/tx/tx';
import type { SystemPrincipal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { publicFingerprint } from './archive.ts';
import { CutoverError } from './errors.ts';
import { Bundle, rehostBundle, type Bundle as BundleType } from './bundle.ts';

// `import`: the bundle into a peblish database, in one transaction, idempotent. The database is
// migrated without PUBLIC_ORIGIN (deploy/cutover.md), so the local instance row and the instance
// actor come from the bundle and keep PieFed's URL and key. Local actors keep their ap_ids,
// inboxes and keys (imported_at set, so feddit-admin keeps its hyphen); remote communities go
// through core's remote-actor store; follows land accepted (decision 3). Accounts import without
// a password: the people sign in through a password reset.

export class ImportRefused extends CutoverError {
  override readonly name = 'ImportRefused';
}

export type ImportOptions = {
  /** The target's PUBLIC_ORIGIN. */
  publicOrigin: string;
  /** A throwaway host to rehost the bundle's ids onto; it must be PUBLIC_ORIGIN's host. */
  rehearsalHost?: string;
};

type Tally = { created: number; present: number };
export type ImportReport = {
  origin: string;
  rehearsal: boolean;
  /** The federation switch, turned off before anything else: whether it was on before this run. */
  federation: { deliveryEnabled: false; wasOn: boolean };
  instanceActor: Tally;
  users: Tally;
  communities: Tally;
  remoteCommunities: Tally & { skippedDeleted: number };
  follows: Tally;
  /** PieFed's banned instances, blocked here: the ones this run blocked, and every domain. */
  peerBlocks: Tally & { domains: string[] };
};

/** The bundle as it will be written: checked against the target origin, rehosted for a rehearsal. */
export function planImport(bundle: BundleType, options: ImportOptions): BundleType {
  const target = canonicalOrigin(options.publicOrigin);
  const targetHost = new URL(target).host;
  const sourceHost = new URL(bundle.source.origin).host;
  if (options.rehearsalHost !== undefined) {
    if (options.rehearsalHost !== targetHost) {
      throw new ImportRefused(`--rehearsal-host ${options.rehearsalHost} is not PUBLIC_ORIGIN's host ${targetHost}`);
    }
    if (targetHost === sourceHost) throw new ImportRefused(`--rehearsal-host ${targetHost} is the bundle's own host; leave it out`);
    return rehostBundle(bundle, target);
  }
  if (sourceHost !== targetHost) {
    throw new ImportRefused(
      `the bundle is for ${sourceHost} but PUBLIC_ORIGIN is ${targetHost}; pass --rehearsal-host ${targetHost} for a rehearsal`,
    );
  }
  return bundle;
}

const date = (value: string | null) => (value === null ? null : new Date(value));

/** The stored key of an actor, by ap_id, or undefined when the actor is new. Refuses a different key: the bundle never replaces one. */
async function existingKey(db: WriteTx, apId: string, key: { keyId: string; publicKeyPem: string }): Promise<Uuid | undefined> {
  const [row] = await db
    .select({ id: actors.id, local: actors.local, keyId: actorKeys.keyId, pem: actorKeys.publicKeyPem })
    .from(actors)
    .leftJoin(actorKeys, and(eq(actorKeys.actorId, actors.id), eq(actorKeys.algorithm, 'rsa')))
    .where(eq(actors.apId, apId));
  if (!row) return undefined;
  if (!row.local) throw new ImportRefused(`${apId} is stored as a remote actor`);
  if (row.keyId !== key.keyId || !row.pem || publicFingerprint(row.pem) !== publicFingerprint(key.publicKeyPem)) {
    throw new ImportRefused(`${apId} is already here with another key; the import never replaces a key`);
  }
  return row.id as Uuid;
}

async function insertKey(db: WriteTx, actorId: Uuid, key: BundleType['instanceActor']['key']): Promise<void> {
  await db
    .insert(actorKeys)
    .values({ actorId, keyId: key.keyId, algorithm: 'rsa', publicKeyPem: key.publicKeyPem, privateKeyPem: key.privateKeyPem });
}

async function localInstanceRow(db: WriteTx, origin: string): Promise<Uuid> {
  const domain = new URL(origin).host;
  const [local] = await db.select({ id: instances.id, origin: instances.origin }).from(instances).where(eq(instances.local, true));
  if (local) {
    if (local.origin !== origin) throw new ImportRefused(`the database's local instance is ${local.origin}, not ${origin}`);
    return local.id as Uuid;
  }
  const [created] = await db.insert(instances).values({ domain, origin, local: true }).returning({ id: instances.id });
  return created!.id as Uuid;
}

async function importInstanceActor(db: WriteTx, instanceId: Uuid, actor: BundleType['instanceActor']): Promise<boolean> {
  const [minted] = await db
    .select({ apId: actors.apId })
    .from(actors)
    .where(and(eq(actors.local, true), eq(actors.kind, 'Application')));
  if (minted && minted.apId !== actor.apId) {
    throw new ImportRefused(
      `the database already has the instance actor ${minted.apId}: import into a fresh database migrated without PUBLIC_ORIGIN`,
    );
  }
  if (await existingKey(db, actor.apId, actor.key)) return false;
  const id = uuidv7() as Uuid;
  await db.insert(actors).values({
    id,
    apId: actor.apId,
    kind: 'Application',
    local: true,
    instanceId,
    name: actor.name,
    displayName: actor.displayName,
    inboxUrl: actor.inboxUrl,
    sharedInboxUrl: actor.sharedInboxUrl,
    outboxUrl: actor.outboxUrl,
    importedAt: new Date(),
  });
  await insertKey(db, id, actor.key);
  return true;
}

async function importUser(t: Tx, instanceId: Uuid, origin: string, user: BundleType['users'][number]): Promise<boolean> {
  if (await existingKey(t.db, user.apId, user.key)) return false;
  const userId = uuidv7() as Uuid;
  const actorId = uuidv7() as Uuid;
  const summary = markdown(user.summaryMd, origin);
  // The better-auth user without a credential account: sign-in needs a password reset first,
  // which creates the account (better-auth's resetCredentialPassword).
  await t.db.insert(authUser).values({
    id: userId,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
    role: user.role,
    twoFactorEnabled: false,
  });
  await t.db.insert(actors).values({
    id: actorId,
    apId: user.apId,
    // A local account is a Person (actors_user_is_local_person); bot is the flag.
    kind: 'Person',
    local: true,
    instanceId,
    name: user.name,
    displayName: user.displayName,
    summaryMd: summary.md,
    summaryHtml: summary.html,
    inboxUrl: user.inboxUrl,
    sharedInboxUrl: user.sharedInboxUrl,
    outboxUrl: user.outboxUrl,
    followersUrl: user.followersUrl,
    bot: user.bot,
    discoverable: user.discoverable,
    indexable: user.indexable,
    userId,
    importedAt: new Date(),
    publishedAt: date(user.publishedAt),
  });
  await insertKey(t.db, actorId, user.key);
  // No age declaration: an imported account has not declared 16+ here (identity/tables.ts).
  await t.emit({ type: 'actor.created', v: 1, actorId, kind: 'Person', local: true });
  return true;
}

async function actorIdOf(db: WriteTx, apId: string): Promise<{ id: Uuid; local: boolean } | undefined> {
  const [row] = await db.select({ id: actors.id, local: actors.local }).from(actors).where(eq(actors.apId, apId));
  return row ? { id: row.id as Uuid, local: row.local } : undefined;
}

async function importCommunity(t: Tx, instanceId: Uuid, origin: string, community: BundleType['communities'][number]): Promise<boolean> {
  if (await existingKey(t.db, community.apId, community.key)) return false;
  const id = uuidv7() as Uuid;
  const summary = markdown(community.summaryMd, origin);
  const now = new Date();
  await t.db.insert(actors).values({
    id,
    apId: community.apId,
    kind: 'Group',
    local: true,
    instanceId,
    name: community.name,
    displayName: community.displayName,
    summaryMd: summary.md,
    summaryHtml: summary.html,
    inboxUrl: community.inboxUrl,
    sharedInboxUrl: community.sharedInboxUrl,
    outboxUrl: community.outboxUrl,
    followersUrl: community.followersUrl,
    featuredUrl: community.featuredUrl,
    moderatorsUrl: community.moderatorsUrl,
    sensitive: community.sensitive,
    nsfl: community.nsfl,
    postingRestrictedToMods: community.postingRestrictedToMods,
    postingWarning: community.postingWarning,
    discoverable: community.discoverable,
    indexable: community.indexable,
    importedAt: now,
    publishedAt: date(community.publishedAt),
  });
  await insertKey(t.db, id, community.key);
  await replaceLanguages(t.db, id, community.languages);
  const staff = [
    ...community.owners.map((apId, index) => ({ apId, role: index === 0 ? ('owner' as const) : ('moderator' as const) })),
    ...community.moderators.map((apId) => ({ apId, role: 'moderator' as const })),
  ];
  for (const { apId, role } of staff) {
    const moderator = await actorIdOf(t.db, apId);
    if (!moderator?.local) throw new ImportRefused(`${community.name}'s moderator ${apId} is not an imported user`);
    await t.db
      .insert(communityModerators)
      .values({ communityId: id, moderatorId: moderator.id, role, source: 'local', verifiedAt: now })
      .onConflictDoNothing();
  }
  await t.emit({ type: 'actor.created', v: 1, actorId: id, kind: 'Group', local: true });
  return true;
}

async function importRemoteCommunity(
  t: Tx,
  community: BundleType['remoteCommunities'][number],
): Promise<'created' | 'present' | 'deleted'> {
  if (await actorIdOf(t.db, community.apId)) return 'present';
  const principal = await systemPrincipal(t.db, 'import');
  const decision = await authorize('remote.actor_store', principal, { apId: community.apId }, { db: t.db });
  if (!decision.ok) throw new ImportRefused(`remote.actor_store refused: ${decision.reason}`);
  const stored = await storeRemoteActor.within(t, decision.grant, {
    apId: community.apId,
    kind: 'Group',
    name: community.name,
    displayName: community.displayName,
    summaryHtml: community.summaryHtml,
    inboxUrl: community.inboxUrl,
    sharedInboxUrl: community.sharedInboxUrl,
    outboxUrl: community.outboxUrl,
    followersUrl: community.followersUrl,
    featuredUrl: community.featuredUrl,
    moderatorsUrl: community.moderatorsUrl,
    iconUrl: community.iconUrl,
    bannerUrl: community.bannerUrl,
    sensitive: community.sensitive,
    nsfl: community.nsfl,
    discoverable: true,
    indexable: true,
    postingRestrictedToMods: community.postingRestrictedToMods,
    postingWarning: null,
    languages: community.languages,
    bot: false,
    publishedAt: date(community.publishedAt),
    updatedAt: null,
    publicKey: community.publicKey ? { keyId: community.publicKey.keyId, ownerApId: community.apId, pem: community.publicKey.pem } : null,
    // PieFed kept no received document; the next refresh from the peer fills raw.
    raw: null,
  });
  return stored.deleted ? 'deleted' : 'created';
}

async function importFollow(t: Tx, follow: BundleType['follows'][number]): Promise<boolean> {
  const follower = await actorIdOf(t.db, follow.followerApId);
  const followee = await actorIdOf(t.db, follow.followeeApId);
  if (!follower?.local) throw new ImportRefused(`follower ${follow.followerApId} is not an imported user`);
  if (!followee) throw new ImportRefused(`followee ${follow.followeeApId} is not in the bundle`);
  const acceptedAt = new Date(follow.acceptedAt);
  const [created] = await t.db
    .insert(follows)
    .values({ followerId: follower.id, followeeId: followee.id, apId: follow.apId, state: 'accepted', acceptedAt })
    .onConflictDoNothing()
    .returning({ id: follows.id });
  if (!created) return false;
  // follow.accepted queues the backfill of a remote community (federation/backfill/consumer.ts); nothing is sent.
  await t.emit({
    type: 'follow.accepted',
    v: 1,
    followId: created.id,
    apId: follow.apId ?? '',
    followerId: follower.id,
    followeeId: followee.id,
    followerLocal: true,
    followeeLocal: followee.local,
  });
  return true;
}

const peerBlockReason = "PieFed's banned instances, carried over at the cutover";

/**
 * Blocks one of PieFed's banned instances through MODF's updatePeer, as the instance importing
 * (peer.update lets the system import principal through): the instance row, peer_controls with
 * blocked set and the peer's other controls kept, a private peer.update modlog row and
 * peer.updated. A peer already blocked is left as it is, so a second run writes nothing.
 */
async function importPeerBlock(t: Tx, principal: SystemPrincipal, domain: string): Promise<boolean> {
  const [held] = await t.db
    .select({ blocked: peerControls.blocked })
    .from(peerControls)
    .innerJoin(instances, eq(instances.id, peerControls.instanceId))
    .where(eq(instances.domain, domain));
  if (held?.blocked) return false;
  const decision = await authorize('peer.update', principal, { domain }, { db: t.db });
  if (!decision.ok) throw new ImportRefused(`peer.update refused for ${domain}: ${decision.reason}`);
  await updatePeer.within(t, decision.grant, { blocked: true, reason: peerBlockReason });
  return true;
}

/**
 * Turns the federation switch (`delivery.enabled`) off in a transaction of its own, before the
 * import reads anything, so it stays off even when the import is refused or fails: the imported
 * follows must not reach any peer until step 8 turns it on. When the database has a local
 * instance actor (a repeat run, or a database the import then refuses), it goes through
 * settings.update as the system import principal, so a change gets its private modlog row and
 * settings.updated. A fresh database has no actor for either to name yet (the import brings it),
 * so there the switch is written as the runbook's SQL writes it; the insert takes the row lock a
 * kill-switch reader waits on. Returns whether it was on.
 */
async function federationOff(): Promise<boolean> {
  return tx(async (t) => {
    const [instanceActor] = await t.db
      .select({ id: actors.id })
      .from(actors)
      .where(and(eq(actors.local, true), eq(actors.kind, 'Application')));
    if (instanceActor) {
      const importer = await systemPrincipal(t.db, 'import');
      const off = { 'delivery.enabled': false } as const;
      const decision = await authorize('settings.update', importer, { keys: Object.keys(off), values: off }, { db: t.db });
      if (!decision.ok) throw new ImportRefused(`settings.update refused for delivery.enabled: ${decision.reason}`);
      const { changed } = await updateSettings.within(t, decision.grant, off);
      return changed.length > 0;
    }
    const [before] = await t.db.select({ value: siteSettings.value }).from(siteSettings).where(eq(siteSettings.key, 'delivery.enabled'));
    await t.db
      .insert(siteSettings)
      .values({ key: 'delivery.enabled', value: false })
      .onConflictDoUpdate({ target: siteSettings.key, set: { value: false, updatedBy: null, updatedAt: sql`now()` } });
    // No row is the contract default, which is on.
    return before === undefined || before.value !== false;
  });
}

const tally = (results: boolean[]): Tally => ({ created: results.filter(Boolean).length, present: results.filter((r) => !r).length });

/**
 * Imports `input` (checked again here) into the database DATABASE_URL names. It first turns the
 * federation switch off (federationOff); after that a refusal or any error writes nothing.
 */
export async function importBundle(input: unknown, options: ImportOptions): Promise<ImportReport> {
  const wasOn = await federationOff();
  const bundle = planImport(Bundle.assert(input), options);
  const origin = canonicalOrigin(bundle.source.origin);
  return tx(async (t) => {
    const instanceId = await localInstanceRow(t.db, origin);
    const instanceActor = await importInstanceActor(t.db, instanceId, bundle.instanceActor);
    const users = [];
    for (const user of bundle.users) users.push(await importUser(t, instanceId, origin, user));
    const communities = [];
    for (const community of bundle.communities) communities.push(await importCommunity(t, instanceId, origin, community));
    const remote: ('created' | 'present' | 'deleted')[] = [];
    for (const community of bundle.remoteCommunities) remote.push(await importRemoteCommunity(t, community));
    const followed = [];
    for (const follow of bundle.follows) followed.push(await importFollow(t, follow));
    const importer = await systemPrincipal(t.db, 'import');
    const blocked = [];
    for (const domain of bundle.blockedInstances) blocked.push(await importPeerBlock(t, importer, domain));
    return {
      origin,
      rehearsal: options.rehearsalHost !== undefined,
      federation: { deliveryEnabled: false as const, wasOn },
      instanceActor: tally([instanceActor]),
      users: tally(users),
      communities: tally(communities),
      remoteCommunities: {
        created: remote.filter((r) => r === 'created').length,
        present: remote.filter((r) => r === 'present').length,
        skippedDeleted: remote.filter((r) => r === 'deleted').length,
      },
      follows: tally(followed),
      peerBlocks: { ...tally(blocked), domains: bundle.blockedInstances },
    };
  });
}
