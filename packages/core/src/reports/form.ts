import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { and, eq } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { db, type Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import { reports } from '../db/tables/moderation.ts';
import type { Result } from '../identity/result.ts';
import { audienceOf, categoriesFor, mayFederate, type ReportAudience, type ReportCategory } from './categories.ts';
import { cut, plainText, readActors } from './read.ts';
import type { ReportTarget } from './types.ts';

// What the report form shows (lane REP): who and what is reported, the plain quote, the
// categories for that kind of target with who sees each, and whether a report can also go to a
// remote instance. The target is checked with the real policy, so the page and the submit
// refuse alike.

export type ReportCategoryOption = {
  key: ReportCategory;
  audience: ReportAudience;
  /** The reporter may ask for the category to be sent on: it may federate and a remote recipient exists. */
  forwardable: boolean;
};

export type ReportForm = {
  target: ReportTarget;
  about: { kind: 'post' | 'comment' | 'person' | 'community'; handle: string; community: string | null };
  /** At most 120 plain characters; null for sensitive, NSFL, removed or deleted content and for people. */
  quote: string | null;
  /** The remote host that would receive a forwarded report: the community's, else the author's; null when none does. */
  host: string | null;
  categories: ReportCategoryOption[];
};

/** The form for a target, or the policy's refusal (not found, deleted, removed, your own, banned, a report already open). */
export async function readReportForm(principal: Principal, target: ReportTarget, q: Queryable = db()): Promise<Result<ReportForm>> {
  const decision = await authorize('report.create', principal, { target, category: 'other', forward: false }, { db: q });
  if (!decision.ok) return decision;
  const options = (host: string | null): ReportCategoryOption[] =>
    categoriesFor(target.kind).map((key) => ({
      key,
      audience: audienceOf(key, target.kind),
      forwardable: host !== null && mayFederate(key, target.kind),
    }));
  if (target.kind === 'actor') {
    const [actor] = await readActors(q, [target.id]);
    const ref = actor?.[1];
    if (!ref) return { ok: false, reason: 'target.not_found' };
    return {
      ok: true,
      target,
      about: { kind: ref.kind === 'Group' ? 'community' : 'person', handle: ref.handle, community: null },
      quote: null,
      host: null,
      categories: options(null),
    };
  }
  const [row] =
    target.kind === 'post'
      ? await q
          .select({
            apId: posts.apId,
            title: posts.title,
            bodyMd: posts.bodyMd,
            contentHtml: posts.contentHtml,
            authorId: posts.authorId,
            communityId: posts.communityId,
            sensitive: posts.sensitive,
            nsfl: posts.nsfl,
          })
          .from(posts)
          .where(eq(posts.id, target.id))
      : await q
          .select({
            apId: comments.apId,
            title: posts.title,
            bodyMd: comments.bodyMd,
            contentHtml: comments.contentHtml,
            authorId: comments.authorId,
            communityId: posts.communityId,
            sensitive: posts.sensitive,
            nsfl: posts.nsfl,
          })
          .from(comments)
          .innerJoin(posts, eq(posts.id, comments.postId))
          .where(eq(comments.id, target.id));
  if (!row) return { ok: false, reason: 'target.not_found' };
  const people = await readActors(q, [row.authorId, row.communityId]);
  const author = people.get(row.authorId);
  const community = people.get(row.communityId);
  if (!author || !community) return { ok: false, reason: 'target.not_found' };
  const remote = !community.local ? community : !author.local ? author : null;
  const host = remote ? new URL(remote.apId).host : null;
  const text = target.kind === 'post' ? row.title : plainText(row.bodyMd, row.contentHtml, row.apId);
  return {
    ok: true,
    target,
    about: { kind: target.kind, handle: author.handle, community: community.handle },
    quote: row.sensitive || row.nsfl ? null : cut(text),
    host,
    categories: options(host),
  };
}

/** What the sent page shows the reporter: the case number and whom they can block. */
export type SentReport = { number: number; blockHandle: string | null };

/** The viewer's own report by number; null for anyone else's (the page answers not found). */
export async function readSentReport(viewerId: Uuid, number: number, q: Queryable = db()): Promise<SentReport | null> {
  const [row] = await q
    .select({
      number: reports.number,
      postId: reports.targetPostId,
      commentId: reports.targetCommentId,
      actorId: reports.targetActorId,
    })
    .from(reports)
    .where(and(eq(reports.number, number), eq(reports.reporterId, viewerId)));
  if (!row) return null;
  let personId: Uuid | null = row.actorId;
  if (row.postId) personId = (await q.select({ id: posts.authorId }).from(posts).where(eq(posts.id, row.postId)))[0]?.id ?? null;
  if (row.commentId)
    personId = (await q.select({ id: comments.authorId }).from(comments).where(eq(comments.id, row.commentId)))[0]?.id ?? null;
  if (!personId || personId === viewerId) return { number: row.number, blockHandle: null };
  const [person] = await q.select({ kind: actors.kind }).from(actors).where(eq(actors.id, personId));
  const ref = person?.kind === 'Person' ? (await readActors(q, [personId])).get(personId) : undefined;
  return { number: row.number, blockHandle: ref?.handle ?? null };
}
