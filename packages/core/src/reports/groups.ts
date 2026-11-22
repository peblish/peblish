import type { Uuid } from '@peblish/schema/ids';
import type { ActorRef, ReportQueueGroup } from '@peblish/schema/views';
import { and, count, inArray, sql, type SQL } from 'drizzle-orm';
import { db, type Queryable } from '../db/read.ts';
import { reports } from '../db/tables/moderation.ts';
import type { Result } from '../identity/result.ts';
import { readActors, readQueue, readQueueCommunities, type QueueGroup, type QueueSort } from './read.ts';
import { targetKey, visibleRows, type QueueTab, type ReportViewer } from './scope.ts';

// The report queue by community (Commons, branch 5): the page readQueue returns, its rows filed
// under the community each belongs to. Everything is read through `visibleRows`, the scope the
// queue and the badge share, so grouping and counting cover only what the viewer may already see.

export type CommunityGroup = ReportQueueGroup<QueueGroup>;

/** The queue page the route sends: the community filter's choices, the chosen one, and the rows by community. */
export type QueueByCommunity = { communities: ActorRef[]; community: Uuid | null; groups: CommunityGroup[]; next: string | null };

type Request = { tab: QueueTab; sort: QueueSort; community?: string | undefined; cursor?: string | undefined };

/**
 * The community a target group is filed under, over one (audience, target) group of report rows:
 * null for the admins' own reports (an admins-only category, or a person or community reported,
 * none of them escalated by a moderator), else the community the rows were filed in. A group that
 * mixes escalations with an admins-only report of the same target (an admin's Resolved tab) is
 * the admins' too: an admins-only report never adds to a community's count.
 */
const communityKey = sql<
  string | null
>`case when ${reports.audience} = 'admins' and bool_or(${reports.escalatedAt} is null) then null else min(${reports.communityId}::text) end`;

/**
 * One page of the queue under `tab`, grouped by community. `community` is an id or a handle (the
 * sidebar and the community page link by handle); one the viewer has no business with (not
 * theirs to moderate) narrows to nothing and reads as if it were not given. Groups come in the
 * order of their first row under the sort; `openCount` is how many target groups the community
 * holds under this tab and filter in all, across pages (on Resolved and Dismissed, how many closed
 * ones). A moderator's Open tab also lists, on its first page, each community they moderate that
 * has nothing waiting (`openCount` 0, no rows). The `community: null` group is an admin's alone.
 */
export async function readQueueByCommunity(viewer: ReportViewer, request: Request, q: Queryable = db()): Promise<Result<QueueByCommunity>> {
  const admin = viewer.siteRole === 'admin';
  const communities = await readQueueCommunities(viewer, q);
  const wanted = request.community?.replace(/^!/, '');
  const chosen = wanted ? communities.find((item) => item.id === wanted || item.handle === wanted) : undefined;
  const page = await readQueue(
    viewer,
    { tab: request.tab, sort: request.sort, ...(chosen && { communityId: chosen.id }), ...(request.cursor && { cursor: request.cursor }) },
    q,
  );
  if (!page.ok) return page;
  const rows = visibleRows(viewer, request.tab, chosen?.id, q);
  if (!rows) return { ok: false, reason: 'auth.admin_required' };

  const [keys, totals] = await Promise.all([
    page.groups.length === 0
      ? []
      : q
          .select({ audience: reports.audience, key: targetKey, community: communityKey })
          .from(reports)
          .where(and(rows, inArray(targetKey, [...new Set(page.groups.map((group) => group.target.id))])))
          .groupBy(reports.audience, targetKey),
    countByCommunity(q, rows),
  ]);
  const filedUnder = new Map(keys.map((row) => [`${row.audience}.${row.key}`, row.community]));
  const openCount = new Map(totals.map((row) => [row.community, row.n]));

  // A moderator's communities are the only ones they may be shown; an admin may be shown any.
  const theirs = new Map(communities.map((community) => [community.id, community]));
  const named = admin
    ? await readActors(
        q,
        [...new Set(keys.flatMap((row) => (row.community ? [row.community] : [])))].filter((id) => !theirs.has(id)),
      )
    : new Map<Uuid, ActorRef>();
  const refOf = (id: Uuid) => theirs.get(id) ?? named.get(id);

  const groups = new Map<string, CommunityGroup>();
  for (const row of page.groups) {
    // A group closed or moved between the two reads has no key: left out, as readQueue leaves out one with no reports.
    if (!filedUnder.has(row.key)) continue;
    const id = filedUnder.get(row.key) ?? null;
    const community = id === null ? null : refOf(id);
    // Belt and braces: no null group and no foreign community for anyone but an admin.
    if (community === undefined || (community === null && !admin)) continue;
    const slot = id ?? '';
    const group = groups.get(slot) ?? { community, openCount: openCount.get(id) ?? 0, rows: [] };
    group.rows.push(row);
    groups.set(slot, group);
  }
  if (!admin && request.tab === 'open' && !request.cursor) {
    for (const community of chosen ? [chosen] : communities) {
      if (!groups.has(community.id) && !openCount.has(community.id)) groups.set(community.id, { community, openCount: 0, rows: [] });
    }
  }
  return { ok: true, communities, community: chosen?.id ?? null, groups: [...groups.values()], next: page.next };
}

/** How many target groups each community holds under `rows`, keyed as `communityKey` files them. */
async function countByCommunity(q: Queryable, rows: SQL) {
  const keyed = q
    .select({ community: communityKey.as('community') })
    .from(reports)
    .where(rows)
    .groupBy(reports.audience, targetKey)
    .as('keyed');
  return q.select({ community: keyed.community, n: count() }).from(keyed).groupBy(keyed.community);
}
