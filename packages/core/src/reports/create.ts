import { newObjectApId } from '@peblish/schema/actor-urls';
import type { Uuid } from '@peblish/schema/ids';
import { type } from 'arktype';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { localInstance } from '../db/local-instance.ts';
import { actors } from '../db/tables/actors.ts';
import { comments, posts } from '../db/tables/content.ts';
import { reports } from '../db/tables/moderation.ts';
import type { Queryable } from '../db/read.ts';
import { defineMutation } from '../tx/mutation.ts';
import { Refused } from '../tx/refused.ts';
import { audienceOf } from './categories.ts';
import { forwardHosts } from './forward.ts';
import type { ReportTarget } from './types.ts';

export const detailsLimit = 2000;

/**
 * The reporter's free text; for a forwarded local report the hosts the form named (`hosts`); for
 * an inbound Flag its id and the document as received.
 */
export const ReportInput = type({ details: 'string', 'hosts?': 'string[]', 'apId?': 'string.url', 'raw?': 'unknown' });
export type ReportInput = typeof ReportInput.infer;

/**
 * Files a report. A local report that asks to federate gets a Flag id (`ap_id`); the Flag itself
 * is built and sent by the outbound consumer, never stored as an activity (the activities table
 * is served by id). An inbound report keeps the peer's Flag in `raw`. The same reporter reports
 * the same target once while it is open: the policy refuses it, and the partial unique index
 * catches the race. A forwarded report stores the hosts it goes to (`forwarded_hosts`): those the
 * form named (`hosts`; every current one when the caller names none) that `forwardHosts` still
 * gives inside the transaction. Only they get the Flag, so a peer unblocked later is never added;
 * when none is left the report stays here, with no Flag id. The recheck reruns the policy and the principal refresh inside the
 * transaction, so a reporter site-banned after the form was authorised is refused
 * (`auth.site_banned`), as is content removed in between.
 */
export const createReport = defineMutation({
  action: 'report.create',
  emits: ['report.created'],
  recheck: true,
  async run(t, grant, raw: ReportInput) {
    const input = ReportInput.assert(raw);
    const details = input.details.trim();
    const { target, category, forward } = grant.subject;
    if (details.length > detailsLimit || (category === 'other' && details === '')) {
      throw new Refused('report.create', 'report.reason_required');
    }
    const local = grant.principal.kind === 'local';
    const instance = await localInstance(t.db);
    const [reporter] = await t.db.select({ instanceId: actors.instanceId }).from(actors).where(eq(actors.id, grant.actorId));
    if (!reporter) throw new Error(`report.create: no actor ${grant.actorId}`);
    const id = uuidv7();
    const audience = audienceOf(category, target.kind);
    const communityId = await communityOf(t.db, target);
    const forwardedHosts = local && forward ? await sendTo(t.db, target, communityId, input.hosts) : [];
    const forwarding = forwardedHosts.length > 0;
    const apId = input.apId ?? (forwarding ? newObjectApId(instance.origin, 'activity', id) : null);
    const [row] = await t.db
      .insert(reports)
      .values({
        id,
        apId,
        local,
        instanceId: local ? instance.id : reporter.instanceId,
        raw: input.raw ?? null,
        reporterId: grant.actorId,
        communityId,
        targetPostId: target.kind === 'post' ? target.id : null,
        targetCommentId: target.kind === 'comment' ? target.id : null,
        targetActorId: target.kind === 'actor' ? target.id : null,
        category,
        reason: details === '' ? null : details,
        audience,
        forwardedHosts,
      })
      .onConflictDoNothing()
      .returning({ number: reports.number });
    if (!row) throw new Refused('report.create', 'report.duplicate');
    await t.emit({
      type: 'report.created',
      v: 1,
      reportId: id,
      number: row.number,
      reporterId: grant.actorId,
      communityId,
      target,
      category,
      audience,
      forward: forwarding,
      apId,
      local,
    });
    return { id, number: row.number, apId };
  },
});

/** The hosts a forwarded report about content goes to: the current ones, limited to those the form named. */
async function sendTo(q: Queryable, target: ReportTarget, communityId: Uuid | null, named: readonly string[] | undefined) {
  if (target.kind === 'actor' || !communityId) return [];
  const [row] =
    target.kind === 'post'
      ? await q.select({ authorId: posts.authorId }).from(posts).where(eq(posts.id, target.id))
      : await q.select({ authorId: comments.authorId }).from(comments).where(eq(comments.id, target.id));
  if (!row) return [];
  const hosts = await forwardHosts(q, communityId, row.authorId);
  return named ? hosts.filter((host) => named.includes(host)) : hosts;
}

/** The community the report belongs to: the one a post or comment lives in, or the community itself when it is the target. */
export async function communityOf(q: Queryable, target: ReportTarget) {
  if (target.kind === 'actor') {
    const [actor] = await q.select({ kind: actors.kind }).from(actors).where(eq(actors.id, target.id));
    return actor?.kind === 'Group' ? target.id : null;
  }
  const [row] =
    target.kind === 'post'
      ? await q.select({ communityId: posts.communityId }).from(posts).where(eq(posts.id, target.id))
      : await q
          .select({ communityId: posts.communityId })
          .from(comments)
          .innerJoin(posts, eq(posts.id, comments.postId))
          .where(eq(comments.id, target.id));
  return row?.communityId ?? null;
}
