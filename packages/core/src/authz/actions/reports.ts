import type { Uuid } from '@peblish/schema/ids';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { actors } from '../../db/tables/actors.ts';
import { reports } from '../../db/tables/moderation.ts';
import { categoriesFor, mayFederate, type ReportAudience, type ReportCategory } from '../../reports/categories.ts';
import type { ReportTarget } from '../../reports/types.ts';
import { allow, deny, type PolicyRequest, type PolicyResult } from '../policy.ts';
import { moderationAuthority } from '../roles.ts';
import { communityDenial, communityState, contentState, isBanned, liveDenial, type StateRead } from '../state.ts';

// Owned by lane REP. Nothing revokes a report itself. createReport, resolveReports and
// routeReports set recheck: true, so the policies here run again with lock inside the
// transaction: the community row FOR NO KEY UPDATE, the moderator row FOR SHARE (no cache), and
// the principal refresh for site bans.

/** The open rows of one queue group: a reported target and an audience. */
export function openGroup(target: ReportTarget, audience: ReportAudience) {
  const column =
    target.kind === 'post' ? reports.targetPostId : target.kind === 'comment' ? reports.targetCommentId : reports.targetActorId;
  return and(eq(column, target.id), eq(reports.audience, audience), eq(reports.status, 'open'));
}

async function groupOf(read: StateRead, target: ReportTarget, audience: ReportAudience) {
  const [row] = await read.db
    .select({ communityId: reports.communityId, escalated: isNotNull(reports.escalatedAt) })
    .from(reports)
    .where(openGroup(target, audience))
    .orderBy(sql`${reports.escalatedAt} desc nulls last`)
    .limit(1);
  return row ?? null;
}

/** A moderator of the group's community (or any admin) may act on a moderators' group. */
async function moderatorOf(request: PolicyRequest<unknown>, communityId: Uuid | null): Promise<PolicyResult> {
  if (communityId === null) return deny('mod.moderator_required');
  const community = await communityState(request, communityId);
  return community ? moderationAuthority(request, community) : deny('target.not_found');
}

const isAdmin = (request: PolicyRequest<unknown>) => request.principal.kind === 'local' && request.principal.siteRole === 'admin';

export const policies = {
  /**
   * Any signed-in person reports a post, comment, person or community; a remote Person does
   * through an inbound Flag. Content must be live in a community that is open and where the
   * reporter is not banned; a person or community only has to exist. Not your own, a category
   * that fits the target, forwarding only when the category may federate and a remote
   * recipient exists, and one open report per reporter and target.
   */
  'report.create': async (
    request: PolicyRequest<{ target: ReportTarget; category: ReportCategory; forward: boolean }>,
  ): Promise<PolicyResult> => {
    const { principal, subject, db } = request;
    if (principal.kind === 'system') return deny('auth.required');
    const { target, category, forward } = subject;
    if (!categoriesFor(target.kind).includes(category)) return deny('report.category_invalid');
    let communityId: Uuid | null = null;
    let remoteRecipient = false;
    if (target.kind === 'actor') {
      const [actor] = await db
        .select({ id: actors.id, kind: actors.kind, deletedAt: actors.deletedAt })
        .from(actors)
        .where(eq(actors.id, target.id));
      if (!actor) return deny('target.not_found');
      if (actor.kind === 'Application') return deny('target.protected');
      if (actor.id === principal.actorId) return deny('report.self');
      if (actor.deletedAt) return deny('target.deleted');
      if (actor.kind === 'Group') {
        communityId = actor.id;
        const community = await communityState(request, actor.id);
        const closed = community && communityDenial(community);
        if (closed) return closed;
      }
    } else {
      const state = await contentState(request, target);
      if (!state) return deny('target.not_found');
      const closed = communityDenial(state.community);
      if (closed) return closed;
      if (await isBanned(request, state.community.id, principal.actorId)) return deny('community.banned');
      const gone = (state.kind === 'comment' ? liveDenial(state.post) : null) ?? liveDenial(state);
      if (gone) return gone;
      if (state.authorId === principal.actorId) return deny('report.self');
      communityId = state.community.id;
      const [author] = await db.select({ local: actors.local }).from(actors).where(eq(actors.id, state.authorId));
      remoteRecipient = !state.community.local || author?.local === false;
    }
    if (forward && !(mayFederate(category, target.kind) && remoteRecipient)) return deny('report.forward_unavailable');
    const column =
      target.kind === 'post' ? reports.targetPostId : target.kind === 'comment' ? reports.targetCommentId : reports.targetActorId;
    const [existing] = await db
      .select({ id: reports.id })
      .from(reports)
      .where(and(eq(reports.reporterId, principal.actorId), eq(column, target.id), eq(reports.status, 'open')))
      .limit(1);
    if (existing) return deny('report.duplicate');
    return principal.kind === 'remote'
      ? allow({ kind: 'owner', actorId: principal.actorId })
      : allow({ kind: 'local-role', actorId: principal.actorId, role: 'user', communityId });
  },

  /**
   * Resolve or dismiss a group. A moderators' group takes a moderator of its community or an
   * admin; an admins' group takes an admin.
   */
  'report.resolve': async (request: PolicyRequest<{ target: ReportTarget; audience: ReportAudience }>): Promise<PolicyResult> => {
    const { principal, subject } = request;
    if (principal.kind !== 'local') return deny('auth.required');
    const group = await groupOf(request, subject.target, subject.audience);
    if (!group) return deny('report.not_open');
    if (subject.audience === 'admins') {
      return isAdmin(request) ? allow({ kind: 'site-admin', actorId: principal.actorId }) : deny('auth.admin_required');
    }
    return moderatorOf(request, group.communityId);
  },

  /**
   * Escalate a moderators' group to the admins (a moderator of its community, or an admin), or
   * send an escalated group back (an admin; a group that was admins-only from the start cannot).
   */
  'report.route': async (
    request: PolicyRequest<{ target: ReportTarget; audience: ReportAudience; to: ReportAudience }>,
  ): Promise<PolicyResult> => {
    const { principal, subject } = request;
    if (principal.kind !== 'local') return deny('auth.required');
    if (subject.to === subject.audience) return deny('report.not_open');
    const group = await groupOf(request, subject.target, subject.audience);
    if (!group) return deny('report.not_open');
    if (subject.to === 'admins') return moderatorOf(request, group.communityId);
    if (!isAdmin(request)) return deny('auth.admin_required');
    return group.escalated ? allow({ kind: 'site-admin', actorId: principal.actorId }) : deny('report.admin_only');
  },
};
