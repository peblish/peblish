import { count, sql } from 'drizzle-orm';
import { db, type Queryable } from '../db/read.ts';
import { reports } from '../db/tables/moderation.ts';
import { countedRows, targetKey, type ReportViewer } from './scope.ts';

export type { ReportViewer } from './scope.ts';

/**
 * The open report groups the viewer may act on: every open group for an admin (moderators',
 * escalated and admins-only), the moderators' groups of the communities they moderate now for a
 * moderator. A group is one reported target and audience, so three reports about one post count once.
 */
export async function openReportCount(viewer: ReportViewer, q: Queryable = db()): Promise<number> {
  const groups = q
    .select({ one: sql`1` })
    .from(reports)
    .where(countedRows(viewer, q))
    .groupBy(reports.audience, targetKey)
    .as('groups');
  const [row] = await q.select({ n: count() }).from(groups);
  return row?.n ?? 0;
}
