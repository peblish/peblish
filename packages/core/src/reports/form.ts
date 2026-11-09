import type { Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { hideNsfw, type NsfwChoice } from '../communities/gate.ts';
import { db, type Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import { reports } from '../db/tables/moderation.ts';
import type { Result } from '../identity/result.ts';
import { readPost } from '../posts/read.ts';
import { audienceOf, categoriesFor, mayFederate, type ReportAudience, type ReportCategory } from './categories.ts';
import { cut, plainText, readActors } from './read.ts';
import type { ReportTarget } from './types.ts';

// What the report form shows (lane REP): who and what is reported, the plain quote, the
// categories for that kind of target with who sees each, and every remote host a report can
// also go to. The target is checked with the real policy, so the page and the submit
// refuse alike. The quote follows the post page's gate for this viewer (readPost): the post's
// and the community's NSFW and NSFL flags, the age declaration and the browser's Hide NSFW.

export type ReportCategoryOption = {
  key: ReportCategory;
  audience: ReportAudience;
  /** The reporter may ask for the category to be sent on: it may federate and a remote recipient exists. */
  forwardable: boolean;
};

export type ReportForm = {
  target: ReportTarget;
  about: { kind: 'post' | 'comment' | 'person' | 'community'; handle: string; community: string | null };
  /** At most 120 plain characters; null for people, and wherever the post page would gate the content for this viewer. */
  quote: string | null;
  /**
   * Every remote host a forwarded report goes to, as the outbound Flag is addressed: the remote
   * community's, and the remote author's when it is another; empty when the report stays here.
   */
  hosts: string[];
  categories: ReportCategoryOption[];
};

/**
 * The form for a target, or the policy's refusal (not found, deleted, removed, your own, banned,
 * a report already open). `nsfw` is the browser's Hide NSFW choice, as the post page reads it.
 */
export async function readReportForm(
  principal: Principal,
  target: ReportTarget,
  q: Queryable = db(),
  nsfw: NsfwChoice = hideNsfw,
): Promise<Result<ReportForm>> {
  const decision = await authorize('report.create', principal, { target, category: 'other', forward: false }, { db: q });
  if (!decision.ok) return decision;
  const options = (hosts: readonly string[]): ReportCategoryOption[] =>
    categoriesFor(target.kind).map((key) => ({
      key,
      audience: audienceOf(key, target.kind),
      forwardable: hosts.length > 0 && mayFederate(key, target.kind),
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
      hosts: [],
      categories: options([]),
    };
  }
  const [row] =
    target.kind === 'post'
      ? await q
          .select({
            postId: posts.id,
            apId: posts.apId,
            title: posts.title,
            bodyMd: posts.bodyMd,
            contentHtml: posts.contentHtml,
            authorId: posts.authorId,
            communityId: posts.communityId,
          })
          .from(posts)
          .where(eq(posts.id, target.id))
      : await q
          .select({
            postId: posts.id,
            apId: comments.apId,
            title: posts.title,
            bodyMd: comments.bodyMd,
            contentHtml: comments.contentHtml,
            authorId: comments.authorId,
            communityId: posts.communityId,
          })
          .from(comments)
          .innerJoin(posts, eq(posts.id, comments.postId))
          .where(eq(comments.id, target.id));
  if (!row) return { ok: false, reason: 'target.not_found' };
  const people = await readActors(q, [row.authorId, row.communityId]);
  const author = people.get(row.authorId);
  const community = people.get(row.communityId);
  if (!author || !community) return { ok: false, reason: 'target.not_found' };
  const hosts = await forwardHosts(q, row.communityId, row.authorId);
  const text = target.kind === 'post' ? row.title : plainText(row.bodyMd, row.contentHtml, row.apId);
  // The post page's own decision for this viewer; a comment is quoted only when its post is shown.
  const viewer = principal.kind === 'local' ? { actorId: principal.actorId, siteRole: principal.siteRole } : null;
  const page = await readPost(row.postId, viewer, q, nsfw);
  const shown = page !== null && page.gate === 'none' && !page.view.deleted && !page.view.removed;
  return {
    ok: true,
    target,
    about: { kind: target.kind, handle: author.handle, community: community.handle },
    quote: shown ? cut(text) : null,
    hosts,
    categories: options(hosts),
  };
}

/**
 * The hosts a forwarded report about this content goes to, in the order the outbound consumer
 * (`federation.reports`) addresses them: the community's when it is remote, then the author's
 * when it is remote and on another host. A host is the actor's inbox host (its id's otherwise).
 */
export async function forwardHosts(q: Queryable, communityId: Uuid, authorId: Uuid): Promise<string[]> {
  const rows = await q
    .select({
      id: actors.id,
      local: actors.local,
      apId: actors.apId,
      inbox: sql<string | null>`coalesce(${actors.sharedInboxUrl}, ${actors.inboxUrl})`,
    })
    .from(actors)
    .where(inArray(actors.id, [communityId, authorId]));
  const hosts: string[] = [];
  for (const id of [communityId, authorId]) {
    const actor = rows.find((row) => row.id === id);
    if (!actor || actor.local) continue;
    const host = URL.parse(actor.inbox ?? actor.apId)?.host;
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

/**
 * What the sent page shows the reporter: the case number, whom they can block, and the hosts
 * the report was forwarded to (empty for a report that stayed here).
 */
export type SentReport = { number: number; blockHandle: string | null; forwardedTo: string[] };

/** The viewer's own report by number; null for anyone else's (the page answers not found). */
export async function readSentReport(viewerId: Uuid, number: number, q: Queryable = db()): Promise<SentReport | null> {
  const [row] = await q
    .select({
      number: reports.number,
      postId: reports.targetPostId,
      commentId: reports.targetCommentId,
      actorId: reports.targetActorId,
      communityId: reports.communityId,
      // A local report gets a Flag id only when the reporter asked for it to be sent on.
      forwarded: sql<boolean>`${reports.local} and ${reports.apId} is not null`,
    })
    .from(reports)
    .where(and(eq(reports.number, number), eq(reports.reporterId, viewerId)));
  if (!row) return null;
  let personId: Uuid | null = row.actorId;
  if (row.postId) personId = (await q.select({ id: posts.authorId }).from(posts).where(eq(posts.id, row.postId)))[0]?.id ?? null;
  if (row.commentId)
    personId = (await q.select({ id: comments.authorId }).from(comments).where(eq(comments.id, row.commentId)))[0]?.id ?? null;
  const forwardedTo =
    row.forwarded && row.actorId === null && row.communityId && personId ? await forwardHosts(q, row.communityId, personId) : [];
  if (!personId || personId === viewerId) return { number: row.number, blockHandle: null, forwardedTo };
  const [person] = await q.select({ kind: actors.kind }).from(actors).where(eq(actors.id, personId));
  const ref = person?.kind === 'Person' ? (await readActors(q, [personId])).get(personId) : undefined;
  return { number: row.number, blockHandle: ref?.handle ?? null, forwardedTo };
}
