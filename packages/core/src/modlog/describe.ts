import type { Uuid } from '@peblish/schema/ids';
import type { ModlogEntry } from '@peblish/schema/modlog';
import { eq, inArray } from 'drizzle-orm';
import { localInstance } from '../db/local-instance.ts';
import { db as readDb, type Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import { instances } from '../db/tables/instances.ts';
import type { ModlogViewer } from './filters.ts';

// What the modlog page shows beside each row: the handles and the post title or comment excerpt
// the row's ids point at, read now. Nothing here is stored in the row, so a purge or a rename
// leaves the log readable (the ap_ids stay) and a restored post shows its title again.

export type ActorLabel = { id: Uuid | null; handle: string; local: boolean; host: string };

export type ModlogTarget =
  | { kind: 'post'; postId: Uuid | null; apId: string; label: string | null; author: ActorLabel | null }
  | { kind: 'comment'; commentId: Uuid | null; postId: Uuid | null; apId: string; label: string | null; author: ActorLabel | null }
  | { kind: 'person'; person: ActorLabel }
  | { kind: 'community'; community: ActorLabel }
  | { kind: 'instance'; host: string };

export type ModlogLine = {
  entry: ModlogEntry;
  /** The action came from another instance (its moderator's ap_id is not on this one). */
  relayed: boolean;
  /** The viewer is staff for this row: an admin, or a moderator of its community. */
  staff: boolean;
  /** Who acted; null when only an announcing community is known. */
  moderator: ActorLabel | null;
  community: ActorLabel | null;
  target: ModlogTarget | null;
};

const EXCERPT = 80;
const excerpt = (markdown: string) => {
  const text = markdown.replace(/\s+/g, ' ').trim();
  return text.length > EXCERPT ? `${text.slice(0, EXCERPT).trimEnd()}...` : text;
};

const hostOf = (apId: string) => URL.parse(apId)?.host ?? apId;
/** `name` for a local actor, `name@host` for a remote one; the ap_id's last path segment when the row is gone. */
const handleFromApId = (apId: string) => {
  const url = URL.parse(apId);
  const name = url?.pathname.split('/').filter(Boolean).at(-1) ?? apId;
  return { handle: `${name}@${url?.host ?? ''}`, host: url?.host ?? '' };
};

/** The handles of these actors (`name` if local, `name@host` if remote), keyed by id; an id with no row is left out. */
export async function labelActors(ids: readonly Uuid[], q: Queryable = readDb()): Promise<Map<Uuid, ActorLabel & { kind: string }>> {
  if (ids.length === 0) return new Map();
  const rows = await q
    .select({ id: actors.id, name: actors.name, local: actors.local, kind: actors.kind, domain: instances.domain })
    .from(actors)
    .innerJoin(instances, eq(instances.id, actors.instanceId))
    .where(inArray(actors.id, [...ids]));
  return new Map(
    rows.map((row) => [
      row.id,
      { id: row.id, handle: row.local ? row.name : `${row.name}@${row.domain}`, local: row.local, host: row.domain, kind: row.kind },
    ]),
  );
}

/**
 * The lines for a page of entries. For a viewer who is not staff for a row, the title or
 * excerpt of removed (or deleted) content is left out: the public log says what was removed and
 * why, not what it said.
 */
export async function describeTargets(
  list: readonly ModlogEntry[],
  options: { viewer: ModlogViewer | null; db?: Queryable },
): Promise<ModlogLine[]> {
  const q = options.db ?? readDb();
  const { viewer } = options;
  const unique = <T>(values: (T | null)[]) => [...new Set(values.filter((value): value is T => value !== null))];
  const postIds = unique(list.map((entry) => entry.targetPostId));
  const commentIds = unique(list.map((entry) => entry.targetCommentId));
  const [postRows, commentRows] = await Promise.all([
    postIds.length === 0
      ? []
      : q
          .select({ id: posts.id, title: posts.title, authorId: posts.authorId, removedAt: posts.removedAt, deletedAt: posts.deletedAt })
          .from(posts)
          .where(inArray(posts.id, postIds)),
    commentIds.length === 0
      ? []
      : q
          .select({
            id: comments.id,
            postId: comments.postId,
            bodyMd: comments.bodyMd,
            authorId: comments.authorId,
            removedAt: comments.removedAt,
            deletedAt: comments.deletedAt,
          })
          .from(comments)
          .where(inArray(comments.id, commentIds)),
  ]);
  const labels = await labelActors(
    unique([
      ...list.flatMap((entry) => [entry.actorId, entry.targetActorId, entry.communityId]),
      ...postRows.map((row) => row.authorId),
      ...commentRows.map((row) => row.authorId),
    ]),
    q,
  );
  const label = (id: Uuid | null, apId: string | null): ActorLabel | null => {
    const known = id ? labels.get(id) : undefined;
    if (known) return known;
    return apId ? { id: null, ...handleFromApId(apId), local: false } : null;
  };
  const posting = new Map(postRows.map((row) => [row.id, row]));
  const commenting = new Map(commentRows.map((row) => [row.id, row]));

  const { origin } = await localInstance(q);
  return list.map((entry): ModlogLine => {
    const staff = !!viewer && (viewer.admin || (entry.communityId !== null && viewer.moderates.includes(entry.communityId)));
    const community = label(entry.communityId, entry.communityApId);
    let target: ModlogTarget | null = null;
    if (entry.targetPostId) {
      const row = posting.get(entry.targetPostId);
      target = {
        kind: 'post',
        postId: entry.targetPostId,
        apId: entry.targetApId ?? '',
        label: row && (staff || (row.removedAt === null && row.deletedAt === null)) ? row.title : null,
        author: row ? label(row.authorId, null) : null,
      };
    } else if (entry.targetCommentId) {
      const row = commenting.get(entry.targetCommentId);
      target = {
        kind: 'comment',
        commentId: entry.targetCommentId,
        postId: row?.postId ?? null,
        apId: entry.targetApId ?? '',
        label: row && (staff || (row.removedAt === null && row.deletedAt === null)) ? excerpt(row.bodyMd ?? '') || null : null,
        author: row ? label(row.authorId, null) : null,
      };
    } else if (entry.targetActorId || (entry.targetApId && entry.action.startsWith('mod.'))) {
      const person = label(entry.targetActorId, entry.targetApId);
      const group = entry.targetActorId ? labels.get(entry.targetActorId)?.kind === 'Group' : false;
      if (person) target = group ? { kind: 'community', community: person } : { kind: 'person', person };
    } else if (entry.action === 'peer.update' && entry.targetApId) {
      target = { kind: 'instance', host: hostOf(entry.targetApId) };
    } else if (entry.action.startsWith('community.') && community) {
      target = { kind: 'community', community };
    }
    return {
      entry,
      relayed: !entry.actorApId.startsWith(`${origin}/`),
      staff,
      moderator: entry.actorId || entry.authority.kind !== 'community-announce' ? label(entry.actorId, entry.actorApId) : null,
      community,
      target,
    };
  });
}
