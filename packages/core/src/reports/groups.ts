import type { Uuid } from '@peblish/schema/ids';
import type { ActorRef, ReportQueueGroup } from '@peblish/schema/views';
import { count, sql, type SQL } from 'drizzle-orm';
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
  const wanted = request.community?.replace(/^!/, '');
  const read = (chosen: ActorRef | undefined) =>
    readQueue(
      viewer,
      {
        tab: request.tab,
        sort: request.sort,
        ...(chosen && { communityId: chosen.id }),
        ...(request.cursor && { cursor: request.cursor }),
      },
      q,
    );
  // The filter's choices and the page are read side by side unless the page waits on a named community.
  const [communities, unfiltered] = await Promise.all([readQueueCommunities(viewer, q), wanted ? null : read(undefined)]);
  const chosen = wanted ? communities.find((item) => item.id === wanted || item.handle === wanted) : undefined;
  const page = unfiltered ?? (await read(chosen));
  if (!page.ok) return page;
  const rows = visibleRows(viewer, request.tab, chosen?.id, q);
  if (!rows) return { ok: false, reason: 'auth.admin_required' };

  const totals = await countByCommunity(q, rows, [...new Set(page.groups.map((group) => group.target.id))]);
  const filedUnder = new Map(totals.flatMap((row) => (row.page ?? []).map((key) => [key, row.community] as const)));
  const openCount = new Map(totals.map((row) => [row.community, row.n]));

  // A moderator's communities are the only ones they may be shown; an admin may be shown any.
  const theirs = new Map(communities.map((community) => [community.id, community]));
  const named = admin
    ? await readActors(
        q,
        totals.flatMap((row) => (row.community && row.page?.length && !theirs.has(row.community) ? [row.community] : [])),
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

/**
 * One read of every target group under `rows`, filed as `communityKey` files them: per community,
 * how many groups it holds, and which of `pageTargets` (the page's) are among them, as
 * `<audience>.<target id>` (a QueueGroup's key).
 */
async function countByCommunity(q: Queryable, rows: SQL, pageTargets: readonly Uuid[]) {
  const keyed = q
    .select({ audience: reports.audience, key: sql<Uuid>`${targetKey}`.as('key'), community: communityKey.as('community') })
    .from(reports)
    .where(rows)
    .groupBy(reports.audience, targetKey)
    .as('keyed');
  return q
    .select({
      community: keyed.community,
      n: count(),
      page: sql<
        string[] | null
      >`array_agg(${keyed.audience} || '.' || ${keyed.key}) filter (where ${keyed.key} = any(${sql.param(pageTargets)}::uuid[]))`,
    })
    .from(keyed)
    .groupBy(keyed.community);
}
