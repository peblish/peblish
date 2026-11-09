import type { Uuid } from '@peblish/schema/ids';
import { excerptLength } from '@peblish/schema/markdown';
import type { ActorRef } from '@peblish/schema/views';
import { and, count, desc, eq, inArray, isNotNull, lte, max, min, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { freshModerator } from '../authz/roles.ts';
import { db, type Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import { instances } from '../db/tables/instances.ts';
import { communityModerators, reports } from '../db/tables/moderation.ts';
import type { Result } from '../identity/result.ts';
import { renderMarkdown } from '../markdown/render.ts';
import { sanitizeRemoteHtml } from '../markdown/sanitize.ts';
import { adminOnly, reportCategories, type ReportAudience, type ReportCategory } from './categories.ts';
import { moderatesAny, targetKey, visibleRows, type QueueTab, type ReportViewer } from './scope.ts';
import type { ReportTarget } from './types.ts';

// The queue's read model (lane REP): groups of reports, one per reported target and audience,
// each with its totals, its newest reports and a summary of the target. Only staff call it.
// The quote is plain text cut to 120 characters and left out for sensitive, removed or deleted
// content and for admins-only categories (the evidence viewer is lane SAFE's); the page blurs it
// until Show.

export const quoteLength = 120;
export const queuePageSize = 50;
/** The newest reports a group shows; its count says how many there are in all. */
export const groupReportLimit = 20;
export type QueueSort = 'oldest' | 'newest' | 'most';

export type ReportRow = {
  id: Uuid;
  number: number;
  category: ReportCategory;
  details: string | null;
  createdAt: string;
  reporter: ActorRef | null;
  /** Set for a report a peer sent as a Flag. */
  remote: boolean;
};

/** Why a group shows no quote. */
export type Withheld = 'admins' | 'sensitive' | 'removed' | 'deleted' | null;

export type QueueSubject =
  | {
      kind: 'post' | 'comment';
      id: Uuid;
      /** The post the content is on (the post itself for a post). */
      postId: Uuid;
      apId: string;
      /** Plain text, at most quoteLength characters; null when withheld. */
      quote: string | null;
      withheld: Withheld;
      removed: boolean;
      deleted: boolean;
      author: ActorRef;
      community: ActorRef;
    }
  | { kind: 'actor'; id: Uuid; person: ActorRef }
  /** The reported row is gone (purged). */
  | { kind: 'gone'; id: Uuid };

export type QueueGroup = {
  /** Unique within a response: `<audience>.<target id>`, used by `?show=`. */
  key: string;
  target: ReportTarget;
  audience: ReportAudience;
  escalatedBy: ActorRef | null;
  subject: QueueSubject;
  categories: ReportCategory[];
  count: number;
  oldestAt: string;
  newestAt: string;
  reports: ReportRow[];
  /** Who closed the group and how; set under Resolved and Dismissed. */
  closed: { by: ActorRef | null; at: string | null; resolution: string | null; note: string | null; modlogId: Uuid | null } | null;
};

export type QueuePage = { groups: QueueGroup[]; next: string | null };

type Request = { tab: QueueTab; communityId?: Uuid; sort: QueueSort; cursor?: string | null };

const orderings = {
  oldest: [min(reports.createdAt)],
  newest: [desc(max(reports.createdAt))],
  most: [desc(count()), min(reports.createdAt)],
} as const;

/** A column of the group's lowest-numbered report for which `present` holds, or null. */
const firstWhere = (column: AnyPgColumn, present: SQL) =>
  sql`(array_agg(${column} order by ${reports.number}) filter (where ${present}))[1]`;

const asCategory = (value: string): ReportCategory => (reportCategories.find((key) => key === value) ?? 'other') as ReportCategory;

/** The groups under one tab, `queuePageSize` at a time. A person who moderates nothing and is no admin gets `mod.moderator_required`. */
export async function readQueue(viewer: ReportViewer, request: Request, q: Queryable = db()): Promise<Result<QueuePage>> {
  const admin = viewer.siteRole === 'admin';
  if (!admin && !(await moderatesAny(viewer, q))) return { ok: false, reason: 'mod.moderator_required' };
  const rows = visibleRows(viewer, request.tab, request.communityId, q);
  if (!rows) return { ok: false, reason: 'auth.admin_required' };
  const offset = Math.max(0, Number.parseInt(request.cursor ?? '0', 10) || 0);
  const heads = await q
    .select({
      audience: reports.audience,
      key: targetKey,
      post: sql<string | null>`min(${reports.targetPostId}::text)`,
      comment: sql<string | null>`min(${reports.targetCommentId}::text)`,
      actor: sql<string | null>`min(${reports.targetActorId}::text)`,
      // The group's totals come from every report in it; the page loads only the newest few.
      count: count(),
      oldestAt: min(reports.createdAt),
      newestAt: max(reports.createdAt),
      categories: sql<string[]>`array_agg(distinct ${reports.category})`,
      escalatedBy: firstWhere(reports.escalatedBy, isNotNull(reports.escalatedBy)).mapWith(reports.escalatedBy),
      resolvedBy: firstWhere(reports.resolvedBy, isNotNull(reports.resolvedAt)).mapWith(reports.resolvedBy),
      resolvedAt: firstWhere(reports.resolvedAt, isNotNull(reports.resolvedAt)).mapWith(reports.resolvedAt),
      resolution: firstWhere(reports.resolution, isNotNull(reports.resolvedAt)).mapWith(reports.resolution),
      resolutionNote: firstWhere(reports.resolutionNote, isNotNull(reports.resolvedAt)).mapWith(reports.resolutionNote),
      modlogId: firstWhere(reports.modlogId, isNotNull(reports.resolvedAt)).mapWith(reports.modlogId),
    })
    .from(reports)
    .where(rows)
    .groupBy(reports.audience, targetKey)
    .orderBy(...orderings[request.sort])
    .limit(queuePageSize + 1)
    .offset(offset);
  const page = heads.slice(0, queuePageSize);
  if (page.length === 0) return { ok: true, groups: [], next: null };

  // At most groupReportLimit reports per group, the newest, so a page is bounded however many
  // reports one target draws.
  const ranked = q
    .select({
      id: reports.id,
      number: reports.number,
      key: sql<string>`${targetKey}`.as('key'),
      audience: reports.audience,
      category: reports.category,
      reason: reports.reason,
      createdAt: reports.createdAt,
      reporterId: reports.reporterId,
      local: reports.local,
      rank: sql<number>`row_number() over (partition by ${reports.audience}, ${targetKey} order by ${reports.number} desc)`.as('rank'),
    })
    .from(reports)
    .where(and(rows, inArray(targetKey, [...new Set(page.map((head) => head.key))])))
    .as('ranked');
  const details = await q
    .select({
      id: ranked.id,
      number: ranked.number,
      key: ranked.key,
      audience: ranked.audience,
      category: ranked.category,
      reason: ranked.reason,
      createdAt: ranked.createdAt,
      reporterId: ranked.reporterId,
      local: ranked.local,
    })
    .from(ranked)
    .where(lte(ranked.rank, groupReportLimit))
    .orderBy(ranked.number);

  const subjects = await readSubjects(q, page);
  const people = await readActors(q, [
    ...new Set(
      [...details.map((row) => row.reporterId), ...page.flatMap((head) => [head.escalatedBy, head.resolvedBy])].filter((id) => id !== null),
    ),
  ]);
  // The reports are a second read: a group closed or moved in between has none left and is
  // left out of this page rather than shown empty.
  const groups = page.flatMap((head): QueueGroup[] => {
    const mine = details.filter((row) => row.key === head.key && row.audience === head.audience);
    if (mine.length === 0 || !head.oldestAt || !head.newestAt) return [];
    const target: ReportTarget = head.post
      ? { kind: 'post', id: head.post }
      : head.comment
        ? { kind: 'comment', id: head.comment }
        : { kind: 'actor', id: head.actor ?? head.key };
    const categories = head.categories.map(asCategory);
    const subject = subjects.get(head.key) ?? { kind: 'gone' as const, id: head.key };
    const group: QueueGroup = {
      key: `${head.audience}.${head.key}`,
      target,
      audience: head.audience,
      escalatedBy: head.escalatedBy ? (people.get(head.escalatedBy) ?? null) : null,
      subject:
        subject.kind !== 'actor' && subject.kind !== 'gone' && categories.some(adminOnly)
          ? { ...subject, quote: null, withheld: 'admins' }
          : subject,
      categories,
      count: head.count,
      oldestAt: head.oldestAt.toISOString(),
      newestAt: head.newestAt.toISOString(),
      reports: mine.map((row) => ({
        id: row.id,
        number: row.number,
        category: asCategory(row.category),
        details: row.reason,
        createdAt: row.createdAt.toISOString(),
        reporter: row.reporterId ? (people.get(row.reporterId) ?? null) : null,
        remote: !row.local,
      })),
      closed: head.resolvedAt
        ? {
            by: head.resolvedBy ? (people.get(head.resolvedBy) ?? null) : null,
            at: head.resolvedAt.toISOString(),
            resolution: head.resolution,
            note: head.resolutionNote,
            modlogId: head.modlogId,
          }
        : null,
    };
    return [group];
  });
  return { ok: true, groups, next: heads.length > queuePageSize ? String(offset + queuePageSize) : null };
}

/** The communities the queue's community filter offers: an admin's with any report, a moderator's own. */
export async function readQueueCommunities(viewer: ReportViewer, q: Queryable = db()): Promise<ActorRef[]> {
  const rows =
    viewer.siteRole === 'admin'
      ? await q.selectDistinct({ id: reports.communityId }).from(reports)
      : await q
          .select({ id: communityModerators.communityId })
          .from(communityModerators)
          .where(and(eq(communityModerators.moderatorId, viewer.actorId), freshModerator));
  const ids = rows.flatMap(({ id }) => (id ? [id] : []));
  return [...(await readActors(q, ids)).values()].sort((a, b) => a.handle.localeCompare(b.handle));
}

/** ActorRefs for ids, handle as everywhere: the name for local actors, name@host for remote. */
export async function readActors(q: Queryable, ids: readonly Uuid[]): Promise<Map<Uuid, ActorRef>> {
  if (ids.length === 0) return new Map();
  const rows = await q
    .select({
      id: actors.id,
      apId: actors.apId,
      kind: actors.kind,
      name: actors.name,
      displayName: actors.displayName,
      local: actors.local,
      domain: instances.domain,
    })
    .from(actors)
    .innerJoin(instances, eq(instances.id, actors.instanceId))
    .where(inArray(actors.id, [...ids]));
  return new Map(rows.map(({ domain, ...row }) => [row.id, { ...row, handle: row.local ? row.name : `${row.name}@${domain}` }]));
}

type Head = { audience: ReportAudience; key: string; post: string | null; comment: string | null; actor: string | null };

async function readSubjects(q: Queryable, page: Head[]): Promise<Map<string, QueueSubject>> {
  const postIds = page.flatMap((head) => (head.post ? [head.post] : []));
  const commentIds = page.flatMap((head) => (head.comment ? [head.comment] : []));
  const actorIds = page.flatMap((head) => (head.actor ? [head.actor] : []));
  const [postRows, commentRows] = await Promise.all([
    postIds.length === 0
      ? []
      : q
          .select({
            id: posts.id,
            apId: posts.apId,
            title: posts.title,
            bodyMd: posts.bodyMd,
            contentHtml: posts.contentHtml,
            authorId: posts.authorId,
            communityId: posts.communityId,
            sensitive: posts.sensitive,
            nsfl: posts.nsfl,
            removedAt: posts.removedAt,
            deletedAt: posts.deletedAt,
          })
          .from(posts)
          .where(inArray(posts.id, postIds)),
    commentIds.length === 0
      ? []
      : q
          .select({
            id: comments.id,
            apId: comments.apId,
            postId: comments.postId,
            bodyMd: comments.bodyMd,
            contentHtml: comments.contentHtml,
            authorId: comments.authorId,
            communityId: posts.communityId,
            sensitive: posts.sensitive,
            nsfl: posts.nsfl,
            removedAt: comments.removedAt,
            deletedAt: comments.deletedAt,
          })
          .from(comments)
          .innerJoin(posts, eq(posts.id, comments.postId))
          .where(inArray(comments.id, commentIds)),
  ]);
  const people = await readActors(q, [
    ...new Set([...postRows, ...commentRows].flatMap((row) => [row.authorId, row.communityId]).concat(actorIds)),
  ]);
  const subjects = new Map<string, QueueSubject>();
  const content = (kind: 'post' | 'comment', row: (typeof postRows)[number] | (typeof commentRows)[number]) => {
    const author = people.get(row.authorId);
    const community = people.get(row.communityId);
    if (!author || !community) return;
    const removed = row.removedAt !== null;
    const deleted = row.deletedAt !== null;
    const withheld: Withheld = deleted ? 'deleted' : removed ? 'removed' : row.sensitive || row.nsfl ? 'sensitive' : null;
    const text = kind === 'post' ? (row as (typeof postRows)[number]).title : plainText(row.bodyMd, row.contentHtml, row.apId);
    subjects.set(row.id, {
      kind,
      id: row.id,
      postId: kind === 'post' ? row.id : (row as (typeof commentRows)[number]).postId,
      apId: row.apId,
      quote: withheld ? null : cut(text),
      withheld,
      removed,
      deleted,
      author,
      community,
    });
  };
  for (const row of postRows) content('post', row);
  for (const row of commentRows) content('comment', row);
  for (const id of actorIds) {
    const person = people.get(id);
    if (person) subjects.set(id, { kind: 'actor', id, person });
  }
  return subjects;
}

/** Plain text from a Markdown body, else from remote HTML, as the feed's excerpt reads it. */
export function plainText(bodyMd: string | null, contentHtml: string | null, apId: string): string {
  if (bodyMd) return renderMarkdown(bodyMd.slice(0, 2_000), { baseOrigin: new URL(apId).origin, excerptLength }).excerpt;
  if (contentHtml) return sanitizeRemoteHtml(contentHtml.slice(0, 20_000), { baseUrl: apId, excerptLength }).excerpt;
  return '';
}

export const cut = (text: string): string | null => {
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  if (flat === '') return null;
  return flat.length <= quoteLength ? flat : `${flat.slice(0, quoteLength - 1).trimEnd()}…`;
};

export type { QueueTab, ReportViewer } from './scope.ts';
