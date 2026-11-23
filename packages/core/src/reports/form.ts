import type { ActingPrincipal, Principal } from '@peblish/schema/authz';
import type { Uuid } from '@peblish/schema/ids';
import { and, eq } from 'drizzle-orm';
import { authorize } from '../authz/authorize.ts';
import { blockedAmong } from '../blocks/predicate.ts';
import { hideNsfw, showNsfw, type NsfwChoice } from '../communities/gate.ts';
import { db, type Queryable } from '../db/read.ts';
import { actors } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import { reports } from '../db/tables/moderation.ts';
import type { Result } from '../identity/result.ts';
import { readPost, type PostPage, type Viewer } from '../posts/read.ts';
import { audienceOf, categoriesFor, mayFederate, type ReportAudience, type ReportCategory } from './categories.ts';
import { forwardHosts } from './forward.ts';
import { cut, plainText, readActors } from './read.ts';
import type { ReportTarget } from './types.ts';

// What the report form shows (lane REP): who and what is reported, the plain quote, the
// categories for that kind of target with who sees each, and every remote host a report can
// also go to. The target is checked with the real policy, so the page and the submit
// refuse alike. The quote follows the post page's gate for this viewer (readPost): the post's
// and the community's NSFW and NSFL flags, the age declaration and the browser's Hide NSFW. Who
// wrote it is named only where the post page and its thread would name them (authorNamed).

export type ReportCategoryOption = {
  key: ReportCategory;
  audience: ReportAudience;
  /** The reporter may ask for the category to be sent on: it may federate and a remote recipient exists. */
  forwardable: boolean;
};

export type ReportForm = {
  target: ReportTarget;
  /** `handle` is null where the post page would not name the author to this viewer: the form names the community alone. */
  about: { kind: 'post' | 'comment' | 'person' | 'community'; handle: string | null; community: string | null };
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
            deletedAt: posts.deletedAt,
            removedAt: posts.removedAt,
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
            deletedAt: comments.deletedAt,
            removedAt: comments.removedAt,
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
  // The post or comment as it is now, not as the policy found it a moment ago: no text once
  // deleted or removed. A comment is also hidden as the thread hides it from this viewer, by
  // someone they block (blockedAmong); the post page shows such a post.
  const hidden =
    row.deletedAt !== null ||
    row.removedAt !== null ||
    (target.kind === 'comment' && viewer !== null && (await blockedAmong(q, viewer.actorId, [row.authorId])).has(row.authorId));
  const shown = page !== null && page.gate === 'none' && !page.view.deleted && !page.view.removed && !hidden;
  const named = authorNamed(page, target.kind, row.deletedAt !== null);
  return {
    ok: true,
    target,
    about: { kind: target.kind, handle: named ? author.handle : null, community: community.handle },
    quote: shown ? cut(text) : null,
    hosts,
    categories: options(hosts),
  };
}

/**
 * Whether the post page or its thread names the author of a post or comment to this viewer (C10
 * and the tombstones, as web's routes/post/-withheld.ts sends them): never behind the age gate,
 * an access rule that Hide NSFW plays no part in; to the moderators otherwise; and to anyone else
 * unless the comment is deleted or the post is removed (or, for the post itself, deleted).
 */
function authorNamed(page: PostPage | null, target: 'post' | 'comment', commentDeleted: boolean): boolean {
  if (!page || page.gate === 'sign-in' || page.gate === 'age') return false;
  if (page.moderator) return true;
  return target === 'post' ? !page.view.deleted && !page.view.removed : !commentDeleted && !page.view.removed;
}

/**
 * What the sent page shows the reporter: the case number, whom they can block (as the post page
 * would name them now: authorNamed), and the hosts the report was forwarded to (empty for a
 * report that stayed here), as stored when it was filed.
 */
export type SentReport = { number: number; blockHandle: string | null; forwardedTo: string[] };

/** The viewer's own report by number; null for anyone else's (the page answers not found). */
export async function readSentReport(principal: ActingPrincipal, number: number, q: Queryable = db()): Promise<SentReport | null> {
  const viewerId = principal.actorId;
  const viewer: Viewer = principal.kind === 'local' ? { actorId: principal.actorId, siteRole: principal.siteRole } : null;
  const [row] = await q
    .select({
      number: reports.number,
      postId: reports.targetPostId,
      commentId: reports.targetCommentId,
      actorId: reports.targetActorId,
      // Fixed when the report was filed, so a peer blocked or unblocked since changes nothing here.
      forwardedTo: reports.forwardedHosts,
    })
    .from(reports)
    .where(and(eq(reports.number, number), eq(reports.reporterId, viewerId)));
  if (!row) return null;
  const { forwardedTo } = row;
  let personId: Uuid | null = row.actorId;
  let named = true;
  if (row.postId) {
    personId = (await q.select({ id: posts.authorId }).from(posts).where(eq(posts.id, row.postId)))[0]?.id ?? null;
    named = authorNamed(await readPost(row.postId, viewer, q, showNsfw), 'post', false);
  }
  if (row.commentId) {
    const [comment] = await q
      .select({ id: comments.authorId, postId: comments.postId, deletedAt: comments.deletedAt })
      .from(comments)
      .where(eq(comments.id, row.commentId));
    personId = comment?.id ?? null;
    named =
      comment !== undefined && authorNamed(await readPost(comment.postId, viewer, q, showNsfw), 'comment', comment.deletedAt !== null);
  }
  if (!personId || personId === viewerId || !named) return { number: row.number, blockHandle: null, forwardedTo };
  const [person] = await q.select({ kind: actors.kind }).from(actors).where(eq(actors.id, personId));
  const ref = person?.kind === 'Person' ? (await readActors(q, [personId])).get(personId) : undefined;
  return { number: row.number, blockHandle: ref?.handle ?? null, forwardedTo };
}
