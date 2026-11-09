import { createPublicKey } from 'node:crypto';
import type { ActorKind } from '@peblish/schema/ids';
import { and, eq, isNull, ne, notInArray, sql } from 'drizzle-orm';
import { canonicalOrigin } from '../config.ts';
import { actorKeys, actors, communityLanguages } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import { deletionLedger } from '../db/tables/site.ts';
import { defineMutation } from '../tx/mutation.ts';
import { ensureInstance } from './instances.ts';

// Owned by lane FED-A, then REM. The remote-actor store: federation fetches an actor document,
// maps it to this shape and checks it (checkRemoteActor), then these write it. Every mutation
// is for the instance importing (systemPrincipal 'import', authz/actions/remote.ts).

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
 *
 * The stored keys follow the document: a key it no longer advertises (or one we cannot use) is
 * removed and a changed one replaced, so a key the owner dropped stops verifying at the next
 * refresh. An actor that sent a Delete stays deleted: a later fetch changes nothing (it
 * returns `deleted: true`), until an explicit undelete exists.
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
      .onConflictDoUpdate({ target: actors.apId, set: fields, setWhere: and(eq(actors.local, false), isNull(actors.deletedAt)) })
      .returning({ id: actors.id, kind: actors.kind, created: sql<boolean>`(xmax = 0)` });
    if (!row) {
      // The upsert declined: a local actor, or a remote one that was deleted.
      const [held] = await t.db.select({ id: actors.id, local: actors.local }).from(actors).where(eq(actors.apId, input.apId));
      if (!held || held.local) throw new TypeError(`${input.apId} is a local actor`);
      return { id: held.id, instanceId: instance.id, created: false, deleted: true };
    }
    if (row.kind !== input.kind) throw new TypeError(`${input.apId} is stored as a ${row.kind}, not a ${input.kind}`);

    const algorithm = input.publicKey ? keyAlgorithm(input.publicKey.pem) : null;
    // Whatever the document no longer advertises goes first (a key id is unique, so a replaced
    // key must be out of the way before its successor is written).
    await t.db.delete(actorKeys).where(and(eq(actorKeys.actorId, row.id), algorithm ? ne(actorKeys.algorithm, algorithm) : sql`true`));
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
    return { id: row.id, instanceId: instance.id, created: row.created, deleted: false };
  },
});

/** Where a remote deletion came from: the actor's own Delete activity, or its server answering 410 or a Tombstone. */
export type DeletionCause = 'Delete' | 'Tombstone';

export type RemoteActorDeletion = {
  /**
   * Also mark every post and comment the actor wrote deleted (Lemmy's account deletion with
   * `removeData`). Ignored for a community: its content is withheld with the community.
   */
  removeContent?: boolean;
  cause?: DeletionCause;
};

/**
 * A remote actor's deletion: the row stays with its ap_id, endpoints and key (so a signed
 * activity of theirs still verifies and their content keeps its author), the profile is
 * scrubbed and deleted_at is set. With `removeContent` the actor's posts and comments are
 * soft-deleted too, each with its post.deleted or comment.deleted event. Either way one
 * `deletion_ledger` row records it, so a backup restore re-applies it (details.removeContent
 * says to delete the actor's content as well). Nothing happens, and nothing is emitted or
 * recorded, for an actor we do not hold or one already deleted.
 */
export const deleteRemoteActor = defineMutation({
  action: 'remote.actor_delete',
  emits: ['actor.deleted', 'post.deleted', 'comment.deleted'],
  async run(t, grant, input: RemoteActorDeletion | void) {
    const [actor] = await t.db
      .select({ id: actors.id, kind: actors.kind, deletedAt: actors.deletedAt })
      .from(actors)
      .where(and(eq(actors.apId, grant.subject.apId), eq(actors.local, false)))
      .for('no key update');
    if (!actor || actor.deletedAt) return { deleted: false, posts: 0, comments: 0 };
    const now = new Date();
    await t.db
      .update(actors)
      .set({ displayName: null, summaryHtml: null, iconUrl: null, bannerUrl: null, postingWarning: null, raw: null, deletedAt: now })
      .where(eq(actors.id, actor.id));

    const removeContent = input?.removeContent === true && actor.kind !== 'Group';
    let removedPosts = 0;
    let removedComments = 0;
    if (removeContent) {
      // Posts, then comments: the lock order of the content rows (README, "Rules for writes").
      const gonePosts = await t.db
        .update(posts)
        .set({ deletedAt: now })
        .where(and(eq(posts.authorId, actor.id), isNull(posts.deletedAt)))
        .returning({ id: posts.id, communityId: posts.communityId });
      for (const post of gonePosts) {
        await t.emit({ type: 'post.deleted', v: 1, postId: post.id, communityId: post.communityId, authorId: actor.id, local: false });
      }
      const goneComments = await t.db
        .update(comments)
        .set({ deletedAt: now })
        .where(and(eq(comments.authorId, actor.id), isNull(comments.deletedAt)))
        .returning({ id: comments.id, postId: comments.postId });
      for (const comment of goneComments) {
        await t.emit({ type: 'comment.deleted', v: 1, commentId: comment.id, postId: comment.postId, authorId: actor.id, local: false });
      }
      removedPosts = gonePosts.length;
      removedComments = goneComments.length;
    }
    await t.db.insert(deletionLedger).values({
      subjectKind: 'actor',
      subjectId: actor.id,
      subjectApId: grant.subject.apId,
      reason: 'remote.actor_deleted',
      requestedBy: grant.actorId,
      details: { remote: true, cause: input?.cause ?? 'Delete', removeContent, posts: removedPosts, comments: removedComments },
    });
    await t.emit({ type: 'actor.deleted', v: 1, actorId: actor.id, kind: actor.kind, local: false });
    return { deleted: true, posts: removedPosts, comments: removedComments };
  },
});

/**
 * Takes a remote actor's deletion back, for a server that answers with a valid document for an
 * actor we hold as deleted (a restored account, a 410 that was a mistake). The profile was
 * scrubbed, so the caller stores the fresh document next; content that a deletion removed stays
 * deleted (it cannot be told from content the author deleted one by one). The ledger gets a
 * `remote.actor_undeleted` row after the deletion's, so a restore applies them in order and
 * ends with the actor alive.
 */
export const undeleteRemoteActor = defineMutation({
  action: 'remote.actor_undelete',
  emits: ['actor.updated'],
  async run(t, grant, _input: void) {
    const [actor] = await t.db
      .select({ id: actors.id, kind: actors.kind, deletedAt: actors.deletedAt })
      .from(actors)
      .where(and(eq(actors.apId, grant.subject.apId), eq(actors.local, false)))
      .for('no key update');
    if (!actor?.deletedAt) return { undeleted: false };
    await t.db.update(actors).set({ deletedAt: null }).where(eq(actors.id, actor.id));
    await t.db.insert(deletionLedger).values({
      subjectKind: 'actor',
      subjectId: actor.id,
      subjectApId: grant.subject.apId,
      reason: 'remote.actor_undeleted',
      requestedBy: grant.actorId,
      details: { remote: true },
    });
    await t.emit({ type: 'actor.updated', v: 1, actorId: actor.id, kind: actor.kind, local: false });
    return { undeleted: true };
  },
});
