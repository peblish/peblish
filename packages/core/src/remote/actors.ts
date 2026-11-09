import { createPublicKey } from 'node:crypto';
import type { ActorKind, Uuid } from '@peblish/schema/ids';
import { and, asc, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import type { Authorized } from '../authz/brand.ts';
import { canonicalOrigin } from '../config.ts';
import { db } from '../db/read.ts';
import { actorKeys, actors, communityLanguages } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import { defineMutation } from '../tx/mutation.ts';
import { ensureInstance } from './instances.ts';
import { actorDeletionState, recordDeletion, recordUndeletion, type DeletionCause } from './ledger.ts';

export type { DeletionCause } from './ledger.ts';

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

/** A stored actor's kind would change to one it may not: a community, an instance actor or a person cannot become another. */
export class RemoteActorKindError extends Error {
  override readonly name = 'RemoteActorKindError';
  readonly apId: string;
  readonly stored: ActorKind;
  readonly incoming: ActorKind;

  constructor(apId: string, stored: ActorKind, incoming: ActorKind) {
    super(`${apId} is stored as a ${stored}, not a ${incoming}`);
    this.apId = apId;
    this.stored = stored;
    this.incoming = incoming;
  }
}

/** A person and a bot are one sort of account whose flag a server flips (Mastodon serves a bot as a Service); no other kind changes. */
const accountKinds: readonly ActorKind[] = ['Person', 'Service'];
const kindsThatMayBecome = (kind: ActorKind): readonly ActorKind[] => (accountKinds.includes(kind) ? accountKinds : [kind]);

/**
 * Upserts a remote actor and its public key from a checked document, in one statement per
 * table, so two fetches racing for the same actor end with one row (the unique ap_id decides
 * which insert wins; the other updates). Creates the peer's instance row when it is new. Emits
 * actor.created or actor.updated with local false. A remote document can never replace a local
 * actor. A Person may become a Service and back (an account's bot flag); any other change of a
 * stored actor's kind throws RemoteActorKindError and writes nothing.
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
      .onConflictDoUpdate({
        target: actors.apId,
        set: { ...fields, kind: input.kind },
        setWhere: and(eq(actors.local, false), isNull(actors.deletedAt), inArray(actors.kind, [...kindsThatMayBecome(input.kind)])),
      })
      .returning({ id: actors.id, created: sql<boolean>`(xmax = 0)` });
    if (!row) {
      // The upsert declined: a local actor, a remote one that was deleted, or a kind that may not change.
      const [held] = await t.db
        .select({ id: actors.id, local: actors.local, kind: actors.kind, deletedAt: actors.deletedAt })
        .from(actors)
        .where(eq(actors.apId, input.apId));
      if (!held || held.local) throw new TypeError(`${input.apId} is a local actor`);
      if (held.deletedAt) return { id: held.id, instanceId: instance.id, created: false, deleted: true };
      throw new RemoteActorKindError(input.apId, held.kind, input.kind);
    }

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

export type RemoteActorDeletion = {
  /**
   * Also mark every post and comment the actor wrote deleted (Lemmy's account deletion with
   * `removeData`). Ignored for a community: its content is withheld with the community.
   */
  removeContent?: boolean;
  /** Defaults to `Delete`, the actor's own signed activity. */
  cause?: DeletionCause;
};

/**
 * The first step of a remote actor's deletion, in its own transaction: the row stays with its
 * ap_id, endpoints and key (so a signed activity of theirs still verifies and their content
 * keeps its author), the profile is scrubbed and deleted_at is set. Writes one
 * `deletion_ledger` row for a request that adds something to what is recorded (a first
 * deletion, a signed Delete over a Tombstone, content removal over a plain deletion), so a
 * backup restore re-applies the strongest of them, and emits actor.deleted when the actor
 * changed. Returns null for an actor we do not hold. Once it commits no new content of the actor
 * is accepted (authorize refuses a deleted principal), so the content removal that follows
 * (removeActorContent) works on a closed set.
 */
export const tombstoneRemoteActor = defineMutation({
  action: 'remote.actor_delete',
  emits: ['actor.deleted'],
  async run(t, grant, input: RemoteActorDeletion) {
    const [actor] = await t.db
      .select({ id: actors.id, kind: actors.kind, deletedAt: actors.deletedAt })
      .from(actors)
      .where(and(eq(actors.apId, grant.subject.apId), eq(actors.local, false)))
      .for('no key update');
    if (!actor) return null;
    const cause = input.cause ?? 'Delete';
    const removeContent = input.removeContent === true && actor.kind !== 'Group';
    const actorChanged = actor.deletedAt === null;
    if (actorChanged) {
      await t.db
        .update(actors)
        .set({
          displayName: null,
          summaryHtml: null,
          iconUrl: null,
          bannerUrl: null,
          postingWarning: null,
          raw: null,
          deletedAt: new Date(),
        })
        .where(eq(actors.id, actor.id));
    }
    const recorded = await actorDeletionState(t.db, actor.id);
    const stronger = !recorded || (cause === 'Delete' && !recorded.signedDelete) || (removeContent && !recorded.removeContent);
    if (actorChanged || stronger) {
      await recordDeletion(t, { kind: 'actor', id: actor.id, cause, actorId: grant.actorId, removeContent });
    }
    if (actorChanged) await t.emit({ type: 'actor.deleted', v: 1, actorId: actor.id, kind: actor.kind, local: false });
    return { id: actor.id, actorChanged, removeContent };
  },
});

/**
 * Soft-deletes what a deleted remote actor wrote under one post, in one transaction that locks
 * as every other comment writer does: the community's row, then the post, then the actor's
 * comments under it in path order (README, "Rules for writes"; comments/insert.ts relies on
 * it). The actor's own row is not touched, so nothing here holds it while waiting for those
 * locks. Does nothing unless the actor is already deleted (tombstoneRemoteActor ran first).
 * Each deletion emits post.deleted or comment.deleted with `local: false`.
 */
export const removeActorContentUnderPost = defineMutation({
  action: 'remote.actor_delete',
  emits: ['post.deleted', 'comment.deleted'],
  async run(t, grant, input: { postId: Uuid }) {
    const [actor] = await t.db
      .select({ id: actors.id })
      .from(actors)
      .where(and(eq(actors.apId, grant.subject.apId), eq(actors.local, false), sql`${actors.deletedAt} is not null`));
    if (!actor) return { removed: 0, moved: false };
    const [unlocked] = await t.db.select({ communityId: posts.communityId }).from(posts).where(eq(posts.id, input.postId));
    if (!unlocked) return { removed: 0, moved: false };
    await t.db.select({ id: actors.id }).from(actors).where(eq(actors.id, unlocked.communityId)).for('no key update');
    const [post] = await t.db
      .select({ authorId: posts.authorId, communityId: posts.communityId, deletedAt: posts.deletedAt })
      .from(posts)
      .where(eq(posts.id, input.postId))
      .for('no key update');
    if (!post) return { removed: 0, moved: false };
    if (post.communityId !== unlocked.communityId) return { removed: 0, moved: true };

    const now = new Date();
    let removed = 0;
    if (post.authorId === actor.id && post.deletedAt === null) {
      await t.db.update(posts).set({ deletedAt: now }).where(eq(posts.id, input.postId));
      await t.emit({ type: 'post.deleted', v: 1, postId: input.postId, communityId: post.communityId, authorId: actor.id, local: false });
      removed += 1;
    }
    const mine = await t.db
      .select({ id: comments.id })
      .from(comments)
      .where(and(eq(comments.postId, input.postId), eq(comments.authorId, actor.id), isNull(comments.deletedAt)))
      .orderBy(asc(comments.path))
      .for('no key update');
    if (mine.length > 0) {
      await t.db
        .update(comments)
        .set({ deletedAt: now })
        .where(
          inArray(
            comments.id,
            mine.map((comment) => comment.id),
          ),
        );
      for (const comment of mine) {
        await t.emit({ type: 'comment.deleted', v: 1, commentId: comment.id, postId: input.postId, authorId: actor.id, local: false });
      }
      removed += mine.length;
    }
    return { removed, moved: false };
  },
});

/** Posts handled per page of the actor's content, and times one post is tried again when it moved communities. */
const contentPage = 200;
const movedRetries = 3;

/** Soft-deletes everything the (already deleted) actor wrote, one post at a time; returns how many posts and comments went. */
async function removeActorContent(grant: Authorized<'remote.actor_delete'>, actorId: Uuid): Promise<number> {
  let removed = 0;
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    // The posts the actor wrote that are still live, and the posts it commented on.
    const page = await db().execute<{ id: Uuid }>(sql`
      select id from (
        select id from ${posts} where author_id = ${actorId} and deleted_at is null
        union
        select post_id as id from ${comments} where author_id = ${actorId} and deleted_at is null
      ) held
      where id > ${after}::uuid
      order by id
      limit ${contentPage}`);
    if (page.length === 0) return removed;
    for (const { id } of page) {
      for (let attempt = 0; attempt < movedRetries; attempt++) {
        const result = await removeActorContentUnderPost(grant, { postId: id });
        removed += result.removed;
        if (!result.moved) break;
      }
      after = id;
    }
  }
}

/**
 * A remote actor's deletion: its own signed Delete, or its server answering 410 or a Tombstone.
 * `actorChanged` says whether the actor went from live to deleted just now; `contentRemoved` how
 * many posts and comments were soft-deleted by this call. They are independent: content removal
 * runs for every request that asks for it (`removeContent`), whatever the actor's state before,
 * so a Delete with `removeData` that follows a plain Delete or a Tombstone still removes the
 * content, and a repeat finds nothing left. Nothing happens for an actor we do not hold.
 *
 * Not a single transaction, on purpose. The actor is tombstoned in a transaction of its own
 * (tombstoneRemoteActor, which also writes the ledger row), then the content goes post by post
 * (removeActorContentUnderPost), each in a transaction that takes the community's and the post's
 * locks before the actor's comments under it. An account can have thousands of posts, and a
 * transaction holding the actor row while it waits for community locks could deadlock with a
 * reply that holds a community and waits for the author. So call it outside any open
 * transaction (an inbound handler does it in `prepare`, not `apply`).
 */
export async function deleteRemoteActor(
  grant: Authorized<'remote.actor_delete'>,
  input: RemoteActorDeletion = {},
): Promise<{ actorChanged: boolean; contentRemoved: number }> {
  const tombstoned = await tombstoneRemoteActor(grant, input);
  if (!tombstoned) return { actorChanged: false, contentRemoved: 0 };
  const contentRemoved = tombstoned.removeContent ? await removeActorContent(grant, tombstoned.id) : 0;
  return { actorChanged: tombstoned.actorChanged, contentRemoved };
}

/**
 * Takes a remote actor's deletion back. `via` says who is asking: the actor itself with an
 * Undo(Delete) (the default; always restores), or a refetch that found a valid document
 * (`refresh`), which restores a deletion that came from a 410 or a Tombstone and never one the
 * actor made with its own signed Delete. The check runs under the actor's row lock against the
 * ledger, so a signed Delete that arrives meanwhile wins. The profile was scrubbed, so the
 * caller stores the fresh document next; content that a deletion removed stays deleted (it
 * cannot be told from content the author deleted one by one). Returns `undeleted`, and
 * `signedDelete` when a refresh was declined for that reason. The ledger gets a
 * `remote.actor_undeleted` row after the deletion's, so a restore applies them in order and
 * ends with the actor alive.
 */
export const undeleteRemoteActor = defineMutation({
  action: 'remote.actor_undelete',
  emits: ['actor.updated'],
  async run(t, grant, input: { via?: 'undo' | 'refresh' } | void) {
    const [actor] = await t.db
      .select({ id: actors.id, kind: actors.kind, deletedAt: actors.deletedAt })
      .from(actors)
      .where(and(eq(actors.apId, grant.subject.apId), eq(actors.local, false)))
      .for('no key update');
    if (!actor?.deletedAt) return { undeleted: false, signedDelete: false };
    if (input?.via === 'refresh' && (await actorDeletionState(t.db, actor.id))?.signedDelete) {
      return { undeleted: false, signedDelete: true };
    }
    await t.db.update(actors).set({ deletedAt: null }).where(eq(actors.id, actor.id));
    await recordUndeletion(t, actor.id, grant.actorId);
    await t.emit({ type: 'actor.updated', v: 1, actorId: actor.id, kind: actor.kind, local: false });
    return { undeleted: true, signedDelete: false };
  },
});
