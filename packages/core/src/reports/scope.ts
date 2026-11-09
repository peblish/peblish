import type { Uuid } from '@peblish/schema/ids';
import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { freshModerator } from '../authz/roles.ts';
import { db, type Queryable } from '../db/read.ts';
import { communityModerators, reports } from '../db/tables/moderation.ts';

// Who sees which report rows (lane REP). A moderator sees the moderators' groups of the
// communities they moderate now, and their own escalations; an admin sees everything. The
// queue and the badge count share these conditions, so the count is exactly the Open, Escalated
// and Admins tabs' groups.

/** Who asks: the shell passes the signed-in person with their site role (admin only with two-factor on). */
export type ReportViewer = { actorId: Uuid; siteRole: 'user' | 'admin' };

export const queueTabs = ['open', 'escalated', 'admins', 'resolved', 'dismissed'] as const;
export type QueueTab = (typeof queueTabs)[number];

/** One group is a reported target and an audience; the key is unique across the three target kinds. */
export const targetKey = sql<string>`coalesce(${reports.targetPostId}, ${reports.targetCommentId}, ${reports.targetActorId})`;

const moderatedBy = (viewer: ReportViewer, q: Queryable) =>
  q
    .select({ id: communityModerators.communityId })
    .from(communityModerators)
    .where(and(eq(communityModerators.moderatorId, viewer.actorId), freshModerator));

/** Whether the person moderates any community right now. */
export async function moderatesAny(viewer: ReportViewer, q: Queryable = db()): Promise<boolean> {
  const [row] = await moderatedBy(viewer, q).limit(1);
  return row !== undefined;
}

/**
 * The rows a viewer sees under a tab, or null when the tab is not theirs (a moderator has no
 * Admins tab). `communityId` narrows to one community, which a moderator can only name among theirs.
 */
export function visibleRows(viewer: ReportViewer, tab: QueueTab, communityId: Uuid | undefined, q: Queryable): SQL | null {
  const admin = viewer.siteRole === 'admin';
  if (!admin && tab === 'admins') return null;
  const inCommunity = communityId ? eq(reports.communityId, communityId) : undefined;
  const status = tab === 'resolved' || tab === 'dismissed' ? eq(reports.status, tab) : eq(reports.status, 'open');
  const escalatedBy = eq(reports.escalatedBy, viewer.actorId);
  let shown: SQL | undefined;
  if (admin) {
    if (tab === 'open') shown = eq(reports.audience, 'moderators');
    else if (tab === 'escalated') shown = and(eq(reports.audience, 'admins'), isNotNull(reports.escalatedAt));
    else if (tab === 'admins') shown = and(eq(reports.audience, 'admins'), isNull(reports.escalatedAt));
  } else {
    const mine = and(eq(reports.audience, 'moderators'), inArray(reports.communityId, moderatedBy(viewer, q)));
    if (tab === 'open') shown = mine;
    else if (tab === 'escalated') shown = and(eq(reports.audience, 'admins'), escalatedBy);
    else shown = sql`(${mine} or ${escalatedBy})`;
  }
  return and(status, shown, inCommunity) ?? null;
}

/** The rows the badge counts: all open rows for an admin, the Open tab for a moderator. */
export function countedRows(viewer: ReportViewer, q: Queryable): SQL {
  return viewer.siteRole === 'admin' ? eq(reports.status, 'open') : (visibleRows(viewer, 'open', undefined, q) ?? sql`false`);
}
