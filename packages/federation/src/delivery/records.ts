import type { Queryable } from '@peblish/core/db/read';
import { actorKeys, actors, communityLanguages } from '@peblish/core/db/tables/actors';
import { comments, posts } from '@peblish/core/db/tables/content';
import { instances } from '@peblish/core/db/tables/instances';
import { communityRemovals } from '@peblish/core/moderation/tables';
import { renderMarkdown } from '@peblish/core/markdown/render';
import type { ActorKind } from '@peblish/schema/ids';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Json, JsonObject } from '../mapping/json.ts';
import type { ActorRecord, CommentRecord, PostRecord } from '../mapping/records.ts';
import { announceShape, type AnnounceShape } from './software.ts';

// Reads local rows into the mapping's records: what an activity, an actor document or an
// object document is built from. Shared by the delivery consumer and the documents we serve.

export type ActorRef = {
  id: string;
  apId: string;
  kind: ActorKind;
  name: string;
  local: boolean;
  deleted: boolean;
  inboxUrl: string | null;
  sharedInboxUrl: string | null;
};

export async function actorRefs(db: Queryable, ids: readonly string[]): Promise<Map<string, ActorRef>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: actors.id,
      apId: actors.apId,
      kind: actors.kind,
      name: actors.name,
      local: actors.local,
      deletedAt: actors.deletedAt,
      inboxUrl: actors.inboxUrl,
      sharedInboxUrl: actors.sharedInboxUrl,
    })
    .from(actors)
    .where(inArray(actors.id, [...ids]));
  return new Map(rows.map(({ deletedAt, ...row }) => [row.id, { ...row, deleted: deletedAt !== null }]));
}

/** HTML for a body: the stored rendering, or the Markdown source rendered now (peers get original image URLs). */
function html(stored: string | null, source: string | null, origin: string): string | null {
  if (stored !== null) return stored;
  return source === null ? null : renderMarkdown(source, { baseOrigin: origin }).html;
}

/** Whether a community still shows what it holds: not deleted, and not removed by a site admin. */
async function communityOpen(db: Queryable, community: Pick<ActorRef, 'id' | 'deleted'>): Promise<boolean> {
  if (community.deleted) return false;
  const [removal] = await db
    .select({ communityId: communityRemovals.communityId })
    .from(communityRemovals)
    .where(eq(communityRemovals.communityId, community.id));
  return !removal;
}

export type LoadedPost = {
  record: PostRecord;
  author: ActorRef;
  community: ActorRef;
  /** Neither deleted nor removed: still something to publish. */
  live: boolean;
  /** Live, in a community that is neither deleted nor removed: still something to serve as a document. */
  servable: boolean;
  deletedAt: Date | null;
  bodyMd: string | null;
};

/** A local post as a record with its author and community, or null when there is no such local post. */
export async function loadPost(db: Queryable, origin: string, postId: string): Promise<LoadedPost | null> {
  const [row] = await db
    .select()
    .from(posts)
    .where(and(eq(posts.id, postId), eq(posts.local, true)));
  return row ? postFrom(db, origin, row) : null;
}

/** A local post by its ap_id (for the documents we serve). */
export async function loadPostByApId(db: Queryable, origin: string, apId: string): Promise<LoadedPost | null> {
  const [row] = await db
    .select()
    .from(posts)
    .where(and(eq(posts.apId, apId), eq(posts.local, true)));
  return row ? postFrom(db, origin, row) : null;
}

async function postFrom(db: Queryable, origin: string, row: typeof posts.$inferSelect): Promise<LoadedPost | null> {
  const refs = await actorRefs(db, [row.authorId, row.communityId]);
  const author = refs.get(row.authorId);
  const community = refs.get(row.communityId);
  if (!author || !community) return null;
  const live = row.deletedAt === null && row.removedAt === null;
  return {
    record: {
      apId: row.apId,
      authorApId: author.apId,
      communityApId: community.apId,
      title: row.title,
      url: row.url,
      urlContentType: row.urlContentType,
      altText: row.altText,
      thumbnailUrl: row.thumbnailUrl,
      bodyMd: row.bodyMd,
      contentHtml: html(row.contentHtml, row.bodyMd, origin),
      language: row.language,
      sensitive: row.sensitive,
      nsfl: row.nsfl,
      locked: row.locked,
      featuredCommunity: row.featuredCommunity,
      publishedAt: row.publishedAt,
      editedAt: row.editedAt,
      raw: null,
    },
    author,
    community,
    live,
    servable: live && (await communityOpen(db, community)),
    deletedAt: row.deletedAt,
    bodyMd: row.bodyMd,
  };
}

export type LoadedComment = {
  record: CommentRecord;
  author: ActorRef;
  community: ActorRef;
  /** Neither deleted nor removed: still something to publish. */
  live: boolean;
  /** Live, on a post that is neither deleted nor removed, in a community that is neither deleted nor removed. */
  servable: boolean;
  deletedAt: Date | null;
  bodyMd: string | null;
};

const parents = alias(comments, 'parent');

/**
 * Whether the post or comment `apId` can still be shown, local or remote: live, on a post that is
 * live, in a community that is neither deleted nor removed. Null when no such row is held. Meant
 * for the activities we serve, which can embed content someone else wrote (the community's
 * Announce of a remote Page or Note); the objects themselves are served only when they are ours.
 */
export async function heldContent(db: Queryable, apId: string): Promise<{ servable: boolean; deletedAt: Date | null } | null> {
  const [post] = await db
    .select({
      deletedAt: posts.deletedAt,
      removedAt: posts.removedAt,
      communityId: posts.communityId,
      communityDeletedAt: actors.deletedAt,
    })
    .from(posts)
    .innerJoin(actors, eq(actors.id, posts.communityId))
    .where(eq(posts.apId, apId));
  if (post) {
    const live = post.deletedAt === null && post.removedAt === null;
    const open = await communityOpen(db, { id: post.communityId, deleted: post.communityDeletedAt !== null });
    return { servable: live && open, deletedAt: post.deletedAt };
  }
  const [comment] = await db
    .select({
      deletedAt: comments.deletedAt,
      removedAt: comments.removedAt,
      postGone: sql<boolean>`(${posts.deletedAt} is not null or ${posts.removedAt} is not null)`,
      communityId: posts.communityId,
      communityDeletedAt: actors.deletedAt,
    })
    .from(comments)
    .innerJoin(posts, eq(posts.id, comments.postId))
    .innerJoin(actors, eq(actors.id, posts.communityId))
    .where(eq(comments.apId, apId));
  if (!comment) return null;
  const live = comment.deletedAt === null && comment.removedAt === null;
  const open = await communityOpen(db, { id: comment.communityId, deleted: comment.communityDeletedAt !== null });
  return { servable: live && !comment.postGone && open, deletedAt: comment.deletedAt };
}

/** A local comment as a record, in the community of its post. */
export async function loadComment(db: Queryable, origin: string, commentId: string): Promise<LoadedComment | null> {
  return commentFrom(db, origin, eq(comments.id, commentId));
}

export async function loadCommentByApId(db: Queryable, origin: string, apId: string): Promise<LoadedComment | null> {
  return commentFrom(db, origin, eq(comments.apId, apId));
}

async function commentFrom(db: Queryable, origin: string, where: ReturnType<typeof eq>): Promise<LoadedComment | null> {
  const [row] = await db
    .select({
      comment: comments,
      postApId: posts.apId,
      postGone: sql<boolean>`(${posts.deletedAt} is not null or ${posts.removedAt} is not null)`,
      communityId: posts.communityId,
      parentApId: parents.apId,
    })
    .from(comments)
    .innerJoin(posts, eq(posts.id, comments.postId))
    .leftJoin(parents, eq(parents.id, comments.parentId))
    .where(and(where, eq(comments.local, true)));
  if (!row) return null;
  const { comment } = row;
  const refs = await actorRefs(db, [comment.authorId, row.communityId]);
  const author = refs.get(comment.authorId);
  const community = refs.get(row.communityId);
  if (!author || !community) return null;
  const live = comment.deletedAt === null && comment.removedAt === null;
  return {
    record: {
      apId: comment.apId,
      authorApId: author.apId,
      inReplyToApId: row.parentApId ?? row.postApId,
      communityApId: community.apId,
      bodyMd: comment.bodyMd,
      contentHtml: html(comment.contentHtml, comment.bodyMd, origin),
      language: comment.language,
      distinguished: comment.distinguished,
      publishedAt: comment.publishedAt,
      editedAt: comment.editedAt,
      raw: null,
    },
    author,
    community,
    live,
    servable: live && !row.postGone && (await communityOpen(db, community)),
    deletedAt: comment.deletedAt,
    bodyMd: comment.bodyMd,
  };
}

/** A remote person a body names and we hold: addressed in `cc` and sent the activity directly. */
export type Mentioned = { apId: string; inbox: string };

/**
 * The people and communities a Markdown body names (`@name@host`, `!name@host`), up to the
 * renderer's cap: a Mention tag for each, and the remote people among them with an inbox. A
 * mention whose actor we do not hold stays text: we do not guess a remote actor's id, and
 * nothing is fetched while a consumer holds its transaction. Communities are tagged but never
 * addressed: an activity sent to a community's inbox would be read as a post to it.
 */
export async function mentionsIn(db: Queryable, origin: string, source: string | null): Promise<{ tags: Json[]; people: Mentioned[] }> {
  const found = { tags: [] as Json[], people: [] as Mentioned[] };
  if (source === null) return found;
  const mentions = renderMarkdown(source, { baseOrigin: origin }).mentions;
  for (const { kind, name, host } of mentions) {
    const [row] = await db
      .select({ apId: actors.apId, local: actors.local, inboxUrl: actors.inboxUrl, sharedInboxUrl: actors.sharedInboxUrl })
      .from(actors)
      .innerJoin(instances, eq(instances.id, actors.instanceId))
      .where(
        and(
          eq(instances.domain, host),
          eq(actors.kind, kind === 'person' ? 'Person' : 'Group'),
          sql`lower(${actors.name}) = ${name.toLowerCase()}`,
          sql`${actors.deletedAt} is null`,
        ),
      );
    if (!row) continue;
    found.tags.push({ type: 'Mention', href: row.apId, name: `${kind === 'person' ? '@' : '!'}${name}@${host}` });
    const inbox = row.sharedInboxUrl ?? row.inboxUrl;
    if (kind === 'person' && !row.local && inbox && !found.people.some((person) => person.apId === row.apId)) {
      found.people.push({ apId: row.apId, inbox });
    }
  }
  return found;
}

/** A remote person an earlier copy of a post or comment was addressed to, with the Announce shape their server's software wants. */
export type MentionedBefore = Mentioned & { shape: AnnounceShape };

/**
 * The remote people an earlier copy of the post or comment `objectApId` was addressed to: the
 * `cc` of each Create and Update of it we stored (where mentionsIn put them), read back as the
 * remote people we hold, with their inboxes now. An edit, a deletion or a withdrawal must reach
 * them too, also once the body no longer names them, or their copy keeps what was taken back.
 */
export async function mentionedBefore(db: Queryable, objectApId: string): Promise<MentionedBefore[]> {
  const rows = await db.execute<{ apId: string; inbox: string | null; software: string | null }>(sql`
    select a.ap_id as "apId", coalesce(a.shared_inbox_url, a.inbox_url) as inbox, i.software
    from ${actors} a
    join ${instances} i on i.id = a.instance_id
    where a.kind = 'Person' and not a.local and a.deleted_at is null
      and a.ap_id in (
        select jsonb_array_elements_text(s.raw -> 'cc') from activities s
        where s.local and s.type in ('Create', 'Update') and s.object_ap_id = ${objectApId}
          and jsonb_typeof(s.raw -> 'cc') = 'array'
      )
    order by a.ap_id`);
  return [...rows].flatMap(({ apId, inbox, software }) => (inbox ? [{ apId, inbox, shape: announceShape(software) }] : []));
}

/**
 * Puts `tag` on the post or comment inside a wire document: on the document itself when it is
 * a Page or Note, otherwise on the one nested in its `object` chain (Create, Update, Announce).
 * The mapping does not write tags, so this is the one place they are added.
 */
export function withTags<T extends JsonObject>(wire: T, tags: readonly Json[]): T {
  if (tags.length === 0) return wire;
  let node: JsonObject = wire;
  for (;;) {
    if (node.type === 'Page' || node.type === 'Note') {
      node.tag = [...tags];
      return wire;
    }
    const next = node.object;
    if (typeof next !== 'object' || next === null || Array.isArray(next)) return wire;
    node = next;
  }
}

/**
 * Adds `addresses` to `cc` of the activity and of the post or comment it carries, leaving an
 * Announce's own addressing (the community's followers) alone. Same walk as `withTags`.
 */
export function withCc<T extends JsonObject>(wire: T, addresses: readonly string[]): T {
  if (addresses.length === 0) return wire;
  let node: JsonObject = wire;
  for (;;) {
    if (node.type !== 'Announce') node.cc = [...new Set([...(Array.isArray(node.cc) ? node.cc : []), ...addresses])] as Json[];
    if (node.type === 'Page' || node.type === 'Note') return wire;
    const next = node.object;
    if (typeof next !== 'object' || next === null || Array.isArray(next)) return wire;
    node = next;
  }
}

/** An actors row as the mapping's record, for the documents we serve and the Update we send. */
export async function localActorRecord(db: Queryable, origin: string, row: typeof actors.$inferSelect): Promise<ActorRecord> {
  const [key] = await db
    .select({ keyId: actorKeys.keyId, pem: actorKeys.publicKeyPem })
    .from(actorKeys)
    .where(and(eq(actorKeys.actorId, row.id), eq(actorKeys.algorithm, 'rsa')));
  const group = row.kind === 'Group';
  const languages = group
    ? (
        await db
          .select({ language: communityLanguages.language })
          .from(communityLanguages)
          .where(eq(communityLanguages.communityId, row.id))
      ).map((language) => language.language)
    : [];
  return {
    apId: row.apId,
    kind: row.kind,
    name: row.name,
    // The instance actor's name is the host; Lemmy's site actor wants a human name beside it.
    displayName: row.displayName ?? (row.kind === 'Application' ? row.name : null),
    summaryHtml: html(row.summaryHtml, row.summaryMd, origin),
    summaryMd: row.summaryMd,
    inboxUrl: row.inboxUrl,
    sharedInboxUrl: row.sharedInboxUrl,
    outboxUrl: row.outboxUrl,
    followersUrl: row.followersUrl,
    // A community always has its pinned posts and moderators collections, below its id.
    featuredUrl: row.featuredUrl ?? (group ? `${row.apId}/featured` : null),
    moderatorsUrl: group ? (row.moderatorsUrl ?? `${row.apId}/moderators`) : null,
    iconUrl: row.iconUrl,
    bannerUrl: row.bannerUrl,
    sensitive: row.sensitive,
    nsfl: row.nsfl,
    discoverable: row.discoverable,
    indexable: row.indexable,
    postingRestrictedToMods: row.postingRestrictedToMods,
    postingWarning: row.postingWarning,
    languages,
    bot: row.bot,
    publishedAt: row.publishedAt ?? row.createdAt,
    updatedAt: row.updatedAt,
    publicKey: key ? { keyId: key.keyId, ownerApId: row.apId, pem: key.pem } : null,
    raw: null,
  };
}

/** What a vote is cast on: the post or comment's ap_id and the community it lives in (any post, local or remote). */
export async function voteTarget(
  db: Queryable,
  target: { kind: 'post' | 'comment'; id: string },
): Promise<{ apId: string; community: ActorRef } | null> {
  const [row] =
    target.kind === 'post'
      ? await db.select({ apId: posts.apId, communityId: posts.communityId }).from(posts).where(eq(posts.id, target.id))
      : await db
          .select({ apId: comments.apId, communityId: posts.communityId })
          .from(comments)
          .innerJoin(posts, eq(posts.id, comments.postId))
          .where(eq(comments.id, target.id));
  if (!row) return null;
  const community = (await actorRefs(db, [row.communityId])).get(row.communityId);
  return community ? { apId: row.apId, community } : null;
}
