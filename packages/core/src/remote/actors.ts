import { createPublicKey } from 'node:crypto';
import type { ActorKind } from '@peblish/schema/ids';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import { canonicalOrigin } from '../config.ts';
import { actorKeys, actors, communityLanguages } from '../db/tables/actors.ts';
import { defineMutation } from '../tx/mutation.ts';
import { ensureInstance } from './instances.ts';

// Owned by lane FED-A, inherited by REM. The first remote-actor store: federation fetches an
// actor document, maps it to this shape and checks it (checkRemoteActor), then these write it.
// Both mutations are for the instance importing (systemPrincipal 'import', authz/actions/remote.ts).

/**
 * What a mapped actor document carries into the store. It is the federation mapping's
 * ActorRecord, restated here because core imports nothing from federation; a record is
 * assignable to it.
 */
export type RemoteActorInput = {
  apId: string;
  kind: ActorKind;
  name: string;
  displayName: string | null;
  summaryHtml: string | null;
  inboxUrl: string | null;
  sharedInboxUrl: string | null;
  outboxUrl: string | null;
  followersUrl: string | null;
  featuredUrl: string | null;
  moderatorsUrl: string | null;
  iconUrl: string | null;
  bannerUrl: string | null;
  sensitive: boolean;
  nsfl: boolean;
  discoverable: boolean;
  indexable: boolean;
  postingRestrictedToMods: boolean;
  postingWarning: string | null;
  /** A Group's languages as ISO 639 codes. */
  languages: string[];
  bot: boolean;
  publishedAt: Date | null;
  updatedAt: Date | null;
  publicKey: { keyId: string; ownerApId: string; pem: string } | null;
  /** The document as received. */
  raw: unknown;
};

/**
 * Why a document may not be stored as `input.apId`, or null. The mapping checks shapes and
 * schemes only (its README, "What the caller checks"); this is the origin rule: an actor's
 * endpoints and its key are on its own origin, and the key's owner is the actor itself. A document
 * served from one host cannot then point deliveries at another host or vouch for an actor
 * elsewhere.
 */
export function checkRemoteActor(input: RemoteActorInput): string | null {
  let origin: string;
  try {
    const url = new URL(input.apId);
    if (url.username || url.password || url.hash) return 'the actor id carries credentials or a fragment';
    origin = canonicalOrigin(url.origin);
  } catch {
    return 'the actor id is not an https URL';
  }
  const sameOrigin = (value: string) => {
    try {
      return new URL(value).origin === origin;
    } catch {
      return false;
    }
  };
  const endpoints = { inboxUrl: input.inboxUrl, sharedInboxUrl: input.sharedInboxUrl, outboxUrl: input.outboxUrl };
  const collections = { followersUrl: input.followersUrl, featuredUrl: input.featuredUrl, moderatorsUrl: input.moderatorsUrl };
  for (const [field, value] of Object.entries({ ...endpoints, ...collections })) {
    if (value !== null && !sameOrigin(value)) return `${field} is not on the actor's origin`;
  }
  if (input.publicKey) {
    if (input.publicKey.ownerApId !== input.apId) return "the key's owner is not the actor";
    if (!sameOrigin(input.publicKey.keyId)) return "the key's id is not on the actor's origin";
  }
  if (input.name.trim() === '') return 'the actor has no name';
  return null;
}

/** The key column an actor_keys row goes in: PEM public keys we can verify with, or null. */
function keyAlgorithm(pem: string): 'rsa' | 'ed25519' | null {
  try {
    const type = createPublicKey(pem).asymmetricKeyType;
    return type === 'rsa' || type === 'ed25519' ? type : null;
  } catch {
    return null;
  }
}

/**
 * Upserts a remote actor and its public key from a checked document, in one statement per
 * table, so two fetches racing for the same actor end with one row (the unique ap_id decides
 * which insert wins; the other updates). Creates the peer's instance row when it is new. Emits
 * actor.created or actor.updated with local false. A remote document can never replace a local
 * actor or change a stored actor's kind.
 */
export const storeRemoteActor = defineMutation({
  action: 'remote.actor_store',
  emits: ['actor.created', 'actor.updated'],
  async run(t, grant, input: RemoteActorInput) {
    if (input.apId !== grant.subject.apId) throw new TypeError('the document is not the one the grant names');
    const problem = checkRemoteActor(input);
    if (problem) throw new TypeError(problem);
    const instance = await ensureInstance(t.db, input.apId);
    const now = new Date();
    const fields = {
      name: input.name,
      displayName: input.displayName,
      summaryHtml: input.summaryHtml,
      inboxUrl: input.inboxUrl,
      sharedInboxUrl: input.sharedInboxUrl,
      outboxUrl: input.outboxUrl,
      followersUrl: input.followersUrl,
      featuredUrl: input.featuredUrl,
      moderatorsUrl: input.moderatorsUrl,
      iconUrl: input.iconUrl,
      bannerUrl: input.bannerUrl,
      sensitive: input.sensitive,
      nsfl: input.nsfl,
      bot: input.bot,
      discoverable: input.discoverable,
      indexable: input.indexable,
      postingRestrictedToMods: input.postingRestrictedToMods,
      postingWarning: input.postingWarning,
      publishedAt: input.publishedAt,
      updatedAt: input.updatedAt,
      fetchedAt: now,
      raw: input.raw,
    };
    const [row] = await t.db
      .insert(actors)
      .values({ apId: input.apId, kind: input.kind, local: false, instanceId: instance.id, ...fields })
      .onConflictDoUpdate({ target: actors.apId, set: fields, setWhere: eq(actors.local, false) })
      .returning({ id: actors.id, kind: actors.kind, created: sql<boolean>`(xmax = 0)` });
    if (!row) throw new TypeError(`${input.apId} is a local actor`);
    if (row.kind !== input.kind) throw new TypeError(`${input.apId} is stored as a ${row.kind}, not a ${input.kind}`);

    const algorithm = input.publicKey ? keyAlgorithm(input.publicKey.pem) : null;
    if (input.publicKey && algorithm) {
      const { keyId, pem } = input.publicKey;
      await t.db
        .insert(actorKeys)
        .values({ actorId: row.id, keyId, algorithm, publicKeyPem: pem })
        .onConflictDoUpdate({ target: [actorKeys.actorId, actorKeys.algorithm], set: { keyId, publicKeyPem: pem } });
    }
    if (input.kind === 'Group') {
      const languages = [...new Set(input.languages)];
      const kept = languages.length > 0 ? notInArray(communityLanguages.language, languages) : sql`true`;
      await t.db.delete(communityLanguages).where(and(eq(communityLanguages.communityId, row.id), kept));
      if (languages.length > 0) {
        await t.db
          .insert(communityLanguages)
          .values(languages.map((language) => ({ communityId: row.id, language })))
          .onConflictDoNothing();
      }
    }
    await t.emit({ type: row.created ? 'actor.created' : 'actor.updated', v: 1, actorId: row.id, kind: input.kind, local: false });
    return { id: row.id, instanceId: instance.id, created: row.created };
  },
});

/**
 * A remote actor's own Delete: the row stays with its ap_id, endpoints and key (so a signed
 * activity of theirs still verifies and their content keeps its author), the profile is
 * scrubbed and deleted_at is set. Nothing happens, and nothing is emitted, for an actor we
 * do not hold or one already deleted.
 */
export const deleteRemoteActor = defineMutation({
  action: 'remote.actor_delete',
  emits: ['actor.deleted'],
  async run(t, grant, _input: void) {
    const [actor] = await t.db
      .select({ id: actors.id, kind: actors.kind, deletedAt: actors.deletedAt })
      .from(actors)
      .where(and(eq(actors.apId, grant.subject.apId), eq(actors.local, false)))
      .for('no key update');
    if (!actor || actor.deletedAt) return { deleted: false };
    await t.db
      .update(actors)
      .set({ displayName: null, summaryHtml: null, iconUrl: null, bannerUrl: null, postingWarning: null, raw: null, deletedAt: new Date() })
      .where(eq(actors.id, actor.id));
    await t.emit({ type: 'actor.deleted', v: 1, actorId: actor.id, kind: actor.kind, local: false });
    return { deleted: true };
  },
});
